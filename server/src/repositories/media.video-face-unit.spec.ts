import { EventEmitter } from 'node:events';
import type { Writable } from 'node:stream';
import { TranscodeHardwareAcceleration } from 'src/enum';
import type { LoggingRepository } from 'src/repositories/logging.repository';
import { MediaRepository } from 'src/repositories/media.repository';

const mocks = vi.hoisted(() => ({ ffmpeg: vi.fn() }));
vi.mock('fluent-ffmpeg', () => ({ default: mocks.ffmpeg }));

/** One JPEG-sized write so the frame extraction succeeds. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

const jpegFrame = () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const jpegFrames = (count: number) => Buffer.concat(Array.from({ length: count }, () => jpegFrame()));

describe('video face frame extraction acceleration', () => {
  type MockCommand = EventEmitter &
    Record<string, any> & {
      stream?: Writable;
      ffmpegProc?: { exitCode: number | null; signalCode: NodeJS.Signals | null };
    };
  let commands: MockCommand[];
  let sut: MediaRepository;

  const newCommand = (): MockCommand => {
    const command: MockCommand = Object.assign(new EventEmitter(), {
      inputOptions: vi.fn().mockReturnThis(),
      outputOptions: vi.fn().mockReturnThis(),
      output: vi.fn().mockImplementation((stream: Writable) => {
        command.stream = stream;
        return command;
      }),
      kill: vi.fn(),
      run: vi.fn().mockImplementation(() => {
        command.stream?.write(JPEG);
        command.emit('end');
      }),
    }) as MockCommand;
    commands.push(command);
    return command;
  };

  const options = (command: MockCommand, method: 'inputOptions' | 'outputOptions') =>
    (command[method].mock.calls as unknown[][]).flatMap((call) => call[0] as string[]);

  beforeEach(() => {
    commands = [];
    mocks.ffmpeg.mockReset();
    mocks.ffmpeg.mockImplementation(() => newCommand());
    sut = new MediaRepository({ setContext: vi.fn(), warn: vi.fn() } as unknown as LoggingRepository);
  });

  it('decodes in software by default and keeps the previous seek and scale behaviour', async () => {
    await expect(sut.extractVideoFaceFrame('/video.mp4', 1500)).resolves.toEqual(JPEG);

    expect(mocks.ffmpeg).toHaveBeenCalledTimes(1);
    expect(options(commands[0], 'inputOptions')).toEqual(['-ss', '1.5']);
    const filters = options(commands[0], 'outputOptions').find((option) => option.startsWith('-vf'));
    expect(filters).not.toContain('hwdownload');
    expect(filters).toContain('scale=');
  });

  it('uses NVDEC and downloads the frame before scaling when nvenc acceleration is enabled', async () => {
    await sut.extractVideoFaceFrame('/video.mp4', 2000, {
      accel: TranscodeHardwareAcceleration.Nvenc,
      accelDecode: true,
    });

    expect(options(commands[0], 'inputOptions')).toEqual([
      '-hwaccel_output_format',
      'cuda',
      '-hwaccel',
      'cuda',
      '-ss',
      '2',
    ]);
    const filters = options(commands[0], 'outputOptions').find((option) => option.startsWith('-vf'));
    // GPU frames must be downloaded before CPU-side scaling and JPEG encoding.
    expect(filters).toContain('hwdownload,format=nv12,scale=');
  });

  it('falls back to software decoding when the accelerated attempt fails', async () => {
    mocks.ffmpeg
      .mockImplementationOnce(() => {
        const command = newCommand();
        command.run = vi.fn().mockImplementation(() => command.emit('error', new Error('CUDA not available')));
        return command;
      })
      .mockImplementationOnce(() => newCommand());

    await expect(
      sut.extractVideoFaceFrame('/video.mp4', 500, { accel: TranscodeHardwareAcceleration.Nvenc, accelDecode: true }),
    ).resolves.toEqual(JPEG);

    expect(mocks.ffmpeg).toHaveBeenCalledTimes(2);
    expect(options(commands[0], 'inputOptions')).toContain('-hwaccel');
    expect(options(commands[1], 'inputOptions')).toEqual(['-ss', '0.5']);
  });

  it('does not retry when software decoding itself fails', async () => {
    mocks.ffmpeg.mockImplementationOnce(() => {
      const command = newCommand();
      command.run = vi.fn().mockImplementation(() => command.emit('error', new Error('No such file')));
      return command;
    });

    await expect(sut.extractVideoFaceFrame('/missing.mp4', 0)).rejects.toThrow('No such file');
    expect(mocks.ffmpeg).toHaveBeenCalledTimes(1);
  });

  describe('streaming frame decode', () => {
    beforeEach(() => {
      vi.spyOn(sut, 'probe').mockResolvedValue({
        format: { duration: 4, bitrate: 0 },
        videoStreams: [],
        audioStreams: [],
      } as never);
    });

    /** Emits `count` JPEG frames through the output stream, then ends it like a finished FFmpeg run. */
    // eslint-disable-next-line unicorn/consistent-function-scoping -- uses the describe-scoped command factory
    const streamingCommand = (count: number, child: MockCommand['ffmpegProc']) => {
      mocks.ffmpeg.mockImplementation(() => {
        const command = newCommand();
        command.ffmpegProc = child;
        command.run = vi.fn().mockImplementation(() => {
          command.stream?.write(jpegFrames(count));
          command.stream?.end();
          command.emit('end');
        });
        return command;
      });
      return mocks;
    };

    it('skips non-key frames only when the option is enabled', async () => {
      streamingCommand(2, { exitCode: 0, signalCode: null });

      for await (const frame of sut.streamVideoFaceFrames('/video.mp4', {
        intervalMs: 2000,
        keyframesOnly: true,
      })) {
        void frame;
      }

      expect(options(commands[0], 'inputOptions')).toContain('-skip_frame');
      expect(options(commands[0], 'inputOptions')).toContain('nokey');
      // The sampling grid is still produced by the fps filter, so timestamps stay on the grid.
      expect(options(commands[0], 'outputOptions').find((option) => option.startsWith('-vf'))).toContain('fps=0.5');
    });

    it('decodes every frame by default', async () => {
      streamingCommand(2, { exitCode: 0, signalCode: null });

      for await (const frame of sut.streamVideoFaceFrames('/video.mp4', { intervalMs: 2000 })) {
        void frame;
      }

      expect(options(commands[0], 'inputOptions')).not.toContain('-skip_frame');
    });

    it('never signals an FFmpeg process that already exited', async () => {
      // The child exited before the consumer finished: signalling it now emits ESRCH and crashes the
      // worker inside fluent-ffmpeg's own error handler.
      streamingCommand(2, { exitCode: 0, signalCode: null });

      const received = [];
      for await (const frame of sut.streamVideoFaceFrames('/video.mp4', { intervalMs: 2000 })) {
        received.push(frame.timestampMs);
      }

      expect(received).toEqual([0, 2000]);
      expect(commands[0].kill).not.toHaveBeenCalled();
    });

    it('fails when the decoder produced no frames at all', async () => {
      // Recording "no faces" for a video that was never decoded would silently drop detections.
      streamingCommand(0, { exitCode: 0, signalCode: null });

      await expect(
        (async () => {
          for await (const frame of sut.streamVideoFaceFrames('/video.mp4', { intervalMs: 2000 })) {
            void frame;
          }
        })(),
      ).rejects.toThrow('produced no frames');
    });

    it('stops a still-running decode when the caller releases the stream early', async () => {
      streamingCommand(2, { exitCode: null, signalCode: null });

      const stream = sut.streamVideoFaceFrames('/video.mp4', { intervalMs: 2000 });
      await stream.next();
      await stream.return(undefined);

      expect(commands[0].kill).toHaveBeenCalledWith('SIGKILL');
    });
  });

  it('rejects invalid timestamps before starting FFmpeg', async () => {
    await expect(sut.extractVideoFaceFrame('/video.mp4', -1)).rejects.toThrow('Invalid video face timestamp');
    expect(mocks.ffmpeg).not.toHaveBeenCalled();
  });

  it('ignores NVDEC when accelerated decode is switched off in the config', async () => {
    await sut.extractVideoFaceFrame('/video.mp4', 0, {
      accel: TranscodeHardwareAcceleration.Nvenc,
      accelDecode: false,
    });
    expect(options(commands[0], 'inputOptions')).toEqual(['-ss', '0']);
  });
});
