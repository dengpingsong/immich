import ffmpeg from 'fluent-ffmpeg';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import type { LoggingRepository } from 'src/repositories/logging.repository';
import { MediaRepository } from 'src/repositories/media.repository';

// Opt-in real CLI tests; no database, services, production media, or face imagery.
// VIDEO_FACE_FFMPEG_PATH=/absolute/ffmpeg VIDEO_FACE_FFPROBE_PATH=/absolute/ffprobe \
//   pnpm exec vitest run --config test/vitest.config.mjs src/repositories/media.video-face.spec.ts
// Docker-backed CLI wrappers may use VIDEO_FACE_TEST_TMPDIR inside their private bind mount.
const ffmpegPath = process.env.VIDEO_FACE_FFMPEG_PATH;
const ffprobePath = process.env.VIDEO_FACE_FFPROBE_PATH;
const execute = promisify(execFile);

const encode = (args: string[]) =>
  execute(ffmpegPath!, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], {
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });

const inspect = async (input: string) => {
  const { stdout } = await execute(
    ffprobePath!,
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', input],
    { timeout: 30_000 },
  );
  return JSON.parse(stdout);
};

const expectJpeg = async (buffer: Buffer, width: number, height: number) => {
  expect(buffer.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  expect(buffer.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
  expect(await sharp(buffer).metadata()).toMatchObject({ format: 'jpeg', width, height });
};

const expectColor = async (buffer: Buffer, color: 'red' | 'green' | 'blue', x = 0, y = 0) => {
  const pixel = await sharp(buffer).extract({ left: x, top: y, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
  const channel = { red: 0, green: 1, blue: 2 }[color];
  // Tolerate lossy H.264/JPEG and YUV conversion, but not a wrong temporal segment.
  expect(pixel[channel]).toBeGreaterThan(220);
  const otherChannels = [0, 1, 2].filter((value) => value !== channel);
  for (const other of otherChannels) {
    expect(pixel[other]).toBeLessThan(30);
  }
};

describe.skipIf(!ffmpegPath || !ffprobePath)('MediaRepository.extractVideoFaceFrame (real FFmpeg)', () => {
  let directory: string;
  let sut: MediaRepository;
  let temporal: string;
  let shifted: string;
  let rotated: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(process.env.VIDEO_FACE_TEST_TMPDIR ?? tmpdir(), 'video-face-'));
    directory = await realpath(directory);
    temporal = join(directory, 'temporal.mp4');
    shifted = join(directory, 'shifted.mp4');
    rotated = join(directory, 'rotated.mp4');
    ffmpeg.setFfmpegPath(ffmpegPath!);
    ffmpeg.setFfprobePath(ffprobePath!);
    sut = new MediaRepository({ setContext: vi.fn() } as unknown as LoggingRepository);

    // Twelve seconds, one GOP: seeking must decode past the initial red keyframe.
    await encode([
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=1440x960:r=10:d=12',
      '-vf',
      "drawbox=c=lime:t=fill:enable='gte(t,4)*lt(t,8)',drawbox=c=blue:t=fill:enable='gte(t,8)'",
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-threads',
      '1',
      '-g',
      '120',
      '-keyint_min',
      '120',
      '-sc_threshold',
      '0',
      '-pix_fmt',
      'yuv420p',
      temporal,
    ]);
    await encode(['-i', temporal, '-c', 'copy', '-output_ts_offset', '5', shifted]);
    const landscape = join(directory, 'landscape.mp4');
    await encode([
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=320x180:r=10:d=2',
      '-vf',
      'drawbox=x=160:y=0:w=160:h=180:c=blue:t=fill',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-threads',
      '1',
      '-pix_fmt',
      'yuv420p',
      landscape,
    ]);
    // FFmpeg 7 no longer reliably writes display matrices via the legacy rotate tag.
    await encode(['-display_rotation:v:0', '90', '-i', landscape, '-c', 'copy', rotated]);
  }, 120_000);

  afterAll(async () => {
    // Only the exact canonical directory returned by our own mkdtemp is removed.
    if (!directory) {
      return;
    }
    expect(await realpath(directory)).toBe(directory);
    await rm(directory, { recursive: true, force: true });
  });

  it('preserves anamorphic display aspect ratio when producing square pixels', async () => {
    const anamorphic = join(directory, 'anamorphic.mp4');
    await encode([
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=720x576:r=10:d=1',
      '-vf',
      'setsar=16/15',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-threads',
      '1',
      '-pix_fmt',
      'yuv420p',
      anamorphic,
    ]);
    const metadata = await inspect(anamorphic);
    expect(metadata.streams[0].sample_aspect_ratio).toBe('16:15');
    const frame = await sut.extractVideoFaceFrame(anamorphic, 0);
    await expectJpeg(frame, 768, 576);
    await expectColor(frame, 'red');
  }, 30_000);

  it('uses a twelve-second synthetic fixture with a single keyframe', async () => {
    const metadata = await inspect(temporal);
    expect(Number(metadata.format.duration)).toBeCloseTo(12, 1);
    expect(metadata.streams[0]).toMatchObject({ width: 1440, height: 960, nb_frames: '120' });
    const { stdout } = await execute(
      ffprobePath!,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-skip_frame',
        'nokey',
        '-show_entries',
        'frame=pts_time',
        '-of',
        'json',
        temporal,
      ],
      { timeout: 30_000 },
    );
    expect(JSON.parse(stdout).frames).toHaveLength(1);
  }, 30_000);

  it.each([
    [0, 'red'],
    [3900, 'red'],
    [4000, 'green'],
    [6000, 'green'],
    [7900, 'green'],
    [8000, 'blue'],
    [11_900, 'blue'],
  ] as const)(
    'extracts the correct JPEG at %ims (%s), not a representative thumbnail',
    async (timestamp, color) => {
      const buffer = await sut.extractVideoFaceFrame(temporal, timestamp);
      await expectJpeg(buffer, 1080, 720);
      await expectColor(buffer, color, 540, 360);
    },
    30_000,
  );

  it('seeks relative to a nonzero stream start time', async () => {
    const metadata = await inspect(shifted);
    expect(Number(metadata.streams[0].start_time)).toBeCloseTo(5, 1);
    for (const [timestamp, color] of [
      [0, 'red'],
      [6000, 'green'],
      [11_900, 'blue'],
    ] as const) {
      const buffer = await sut.extractVideoFaceFrame(shifted, timestamp);
      await expectJpeg(buffer, 1080, 720);
      await expectColor(buffer, color, 540, 360);
    }
  }, 60_000);

  it('autorotates display-matrix metadata, preserves square-pixel aspect ratio, and does not upscale', async () => {
    const metadata = await inspect(rotated);
    expect(metadata.streams[0].side_data_list).toEqual(
      expect.arrayContaining([expect.objectContaining({ rotation: 90 })]),
    );
    const buffer = await sut.extractVideoFaceFrame(rotated, 1000);
    await expectJpeg(buffer, 180, 320);
    await expectColor(buffer, 'blue', 90, 80);
    await expectColor(buffer, 'red', 90, 240);
  }, 30_000);

  it.each([-1, NaN, Infinity, -Infinity])(
    'rejects invalid timestamp %s before attempting to open input',
    async (timestamp) => {
      await expect(sut.extractVideoFaceFrame(join(directory, 'does-not-exist.mp4'), timestamp)).rejects.toThrow(
        'Invalid video face timestamp',
      );
    },
  );

  it.each([12_000, 60_000])(
    'rejects a timestamp at or beyond EOF (%ims) rather than returning an empty JPEG',
    async (timestamp) => {
      // FFmpeg versions differ: some emit no bytes, others exit nonzero before the empty-buffer guard.
      await expect(sut.extractVideoFaceFrame(temporal, timestamp)).rejects.toThrow();
    },
    30_000,
  );
});
