import { EventEmitter } from 'node:events';
import type { Writable } from 'node:stream';
import type { LoggingRepository } from 'src/repositories/logging.repository';
import { MediaRepository } from 'src/repositories/media.repository';

const mocks = vi.hoisted(() => ({ ffmpeg: vi.fn() }));
vi.mock('fluent-ffmpeg', () => ({ default: mocks.ffmpeg }));

describe('transcription audio lifecycle', () => {
  let command: EventEmitter & Record<string, any>;
  let output: Writable;
  let sut: MediaRepository;

  beforeEach(() => {
    command = Object.assign(new EventEmitter(), {
      inputOptions: vi.fn().mockReturnThis(),
      outputOptions: vi.fn().mockReturnThis(),
      output: vi.fn().mockImplementation((stream: Writable) => {
        output = stream;
        // fluent-ffmpeg forwards output stream failures and kills its child process.
        stream.on('error', (error) => command.emit('error', error));
        return command;
      }),
      run: vi.fn(),
      kill: vi.fn().mockImplementation(() => command.emit('error', new Error('FFmpeg killed'))),
    });
    mocks.ffmpeg.mockReturnValue(command);
    sut = new MediaRepository({ setContext: vi.fn() } as unknown as LoggingRepository);
  });

  it('kills a running child and removes the abort listener without publishing partial audio', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    command.run.mockImplementation(() => command.emit('start'));
    const result = sut.extractTranscriptionAudio('input', { startMs: 0, durationMs: 1000 }, 1, controller.signal);
    output.write(Buffer.alloc(32));
    controller.abort();
    await expect(result).rejects.toThrow('FFmpeg killed');
    expect(command.kill).toHaveBeenCalledWith('SIGKILL');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(output.destroyed).toBe(true);
  });

  it('kills on start when cancellation races the pre-spawn capability check', async () => {
    const controller = new AbortController();
    command.kill.mockImplementation(() => command);
    const result = sut.extractTranscriptionAudio('input', { startMs: 0, durationMs: 1000 }, 1, controller.signal);
    controller.abort();
    // Pre-spawn kill is a no-op in fluent-ffmpeg; start must check the signal again.
    command.kill.mockImplementation(() => command.emit('error', new Error('FFmpeg killed')));
    command.emit('start');
    await expect(result).rejects.toThrow('FFmpeg killed');
    expect(command.kill).toHaveBeenCalledTimes(2);
  });

  it('rejects output larger than the PCM budget for the requested window', async () => {
    command.run.mockImplementation(() => output.write(Buffer.alloc(32_001)));
    await expect(sut.extractTranscriptionAudio('input', { startMs: 0, durationMs: 1000 }, 1)).rejects.toThrow(
      'Transcription audio exceeded chunk limit',
    );
    expect(output.destroyed).toBe(true);
  });

  it('enforces an FFmpeg deadline and allows an empty decoded window without inventing audio', async () => {
    command.run.mockImplementation(() => command.emit('end'));
    await expect(sut.extractTranscriptionAudio('input', { startMs: 0, durationMs: 1000 }, 1)).resolves.toEqual(
      Buffer.alloc(0),
    );
    expect(mocks.ffmpeg).toHaveBeenCalledWith('input', { niceness: 10, timeout: 120 });
    expect(output.destroyed).toBe(true);
  });
});
