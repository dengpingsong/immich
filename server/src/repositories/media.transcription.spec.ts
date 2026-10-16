import ffmpeg from 'fluent-ffmpeg';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { LoggingRepository } from 'src/repositories/logging.repository';
import { MediaRepository } from 'src/repositories/media.repository';

// Explicit opt-in; generated tones/silence only. Docker CLI wrappers need a writable shared scratch mount.
const ffmpegPath = process.env.VIDEO_FACE_FFMPEG_PATH;
const ffprobePath = process.env.VIDEO_FACE_FFPROBE_PATH;
const execute = promisify(execFile);
const encode = (args: string[]) =>
  execute(ffmpegPath!, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], {
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
const peak = (buffer: Buffer) => {
  let maximum = 0;
  for (let offset = 0; offset < buffer.length; offset += 2) {
    maximum = Math.max(maximum, Math.abs(buffer.readInt16LE(offset)));
  }
  return maximum;
};

describe.skipIf(!ffmpegPath || !ffprobePath)('MediaRepository.extractTranscriptionAudio (real FFmpeg)', () => {
  let directory: string;
  let tone: string;
  let delayed: string;
  let sut: MediaRepository;

  beforeAll(async () => {
    directory = await realpath(await mkdtemp(join(process.env.VIDEO_FACE_TEST_TMPDIR ?? tmpdir(), 'transcription-')));
    tone = join(directory, 'tone.mkv');
    delayed = join(directory, 'delayed.mkv');
    ffmpeg.setFfmpegPath(ffmpegPath!);
    ffmpeg.setFfprobePath(ffprobePath!);
    sut = new MediaRepository({ setContext: vi.fn() } as unknown as LoggingRepository);
    await encode([
      '-f',
      'lavfi',
      '-i',
      'color=s=64x64:r=1:d=4',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=4',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=48000:cl=stereo:d=4',
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-map',
      '2:a',
      '-c:v',
      'libx264',
      '-threads',
      '1',
      '-c:a',
      'pcm_s16le',
      '-ac',
      '2',
      tone,
    ]);
    // Video starts at zero; the first audio packet is at two seconds.
    await encode([
      '-f',
      'lavfi',
      '-i',
      'color=s=64x64:r=1:d=4',
      '-itsoffset',
      '2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=2',
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-c:v',
      'libx264',
      '-threads',
      '1',
      '-c:a',
      'pcm_s16le',
      delayed,
    ]);
  }, 120_000);

  afterAll(async () => {
    if (!directory) {
    	return;
    }

    // Only delete the canonical scratch directory created by this test.
    expect(await realpath(directory)).toBe(directory);
    await rm(directory, { recursive: true, force: true });
  });

  it('returns exactly bounded mono 16kHz signed PCM from a stereo 48kHz track', async () => {
    const buffer = await sut.extractTranscriptionAudio(tone, { startMs: 0, durationMs: 1234 }, 1);
    expect(buffer).toHaveLength(1234 * 32);
    expect(peak(buffer)).toBeGreaterThan(1000);
    expect(peak(buffer)).toBeLessThan(10_000);
  });

  it('selects the requested audio stream instead of always the first', async () => {
    const buffer = await sut.extractTranscriptionAudio(tone, { startMs: 1000, durationMs: 1000 }, 2);
    expect(buffer).toHaveLength(32_000);
    expect(peak(buffer)).toBe(0);
  });

  it('keeps delayed audio aligned to video time by padding initial silence', async () => {
    const buffer = await sut.extractTranscriptionAudio(delayed, { startMs: 0, durationMs: 3000 }, 1);
    expect(buffer).toHaveLength(96_000);
    expect(peak(buffer.subarray(0, 1900 * 32))).toBe(0);
    expect(peak(buffer.subarray(2100 * 32))).toBeGreaterThan(1000);
  });

  it('preserves the remaining delay when seeking into a window before audio begins', async () => {
    const buffer = await sut.extractTranscriptionAudio(delayed, { startMs: 1000, durationMs: 2000 }, 1);
    expect(buffer).toHaveLength(64_000);
    expect(peak(buffer.subarray(0, 900 * 32))).toBe(0);
    expect(peak(buffer.subarray(1100 * 32))).toBeGreaterThan(1000);
  });

  it('returns only available audio near the end rather than reading beyond the video', async () => {
    const buffer = await sut.extractTranscriptionAudio(tone, { startMs: 3500, durationMs: 1000 }, 1);
    expect(buffer.length).toBeLessThanOrEqual(32_000);
    expect(buffer.length).toBeGreaterThan(0);
    expect(peak(buffer)).toBeGreaterThan(1000);
  });

  it('rejects a missing audio stream rather than inventing a successful transcript', async () => {
    await expect(sut.extractTranscriptionAudio(tone, { startMs: 0, durationMs: 1000 }, 9)).rejects.toThrow();
  });

  it('rejects invalid ranges and stream selection before opening any media', async () => {
    await expect(sut.extractTranscriptionAudio('not-opened', { startMs: 0, durationMs: 30_001 }, 1)).rejects.toThrow(
      'Invalid transcription chunk',
    );
    await expect(sut.extractTranscriptionAudio('not-opened', { startMs: 0, durationMs: 1000 }, -1)).rejects.toThrow(
      'Invalid transcription audio stream',
    );
  });

  it('honors cancellation before starting FFmpeg', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Cancelled transcription'));
    await expect(
      sut.extractTranscriptionAudio('not-opened', { startMs: 0, durationMs: 1000 }, 1, controller.signal),
    ).rejects.toThrow('Cancelled transcription');
  });
});
