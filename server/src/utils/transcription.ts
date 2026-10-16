/** Audio is processed sequentially in bounded Whisper-sized windows, never as one full-video buffer. */
export const TRANSCRIPTION_CHUNK_MS = 30_000;
export const TRANSCRIPTION_SAMPLE_RATE = 16_000;
export const WEBVTT_HEADER = 'WEBVTT\n\n';
const MAX_SEGMENTS_PER_CHUNK = 1000;
const MAX_CUE_TEXT_LENGTH = 16_384;

export type TranscriptionChunk = { startMs: number; durationMs: number };
export type TranscriptionSegment = { startMs: number; endMs: number; text: string };
export type SubtitleCue = { startMs: number; endMs: number; text: string };

const isTimestamp = (value: number) => Number.isSafeInteger(value) && value >= 0;

export const validateTranscriptionChunk = ({ startMs, durationMs }: TranscriptionChunk) => {
  if (
    !isTimestamp(startMs) ||
    !Number.isSafeInteger(durationMs) ||
    durationMs <= 0 ||
    durationMs > TRANSCRIPTION_CHUNK_MS ||
    !Number.isSafeInteger(startMs + durationMs)
  ) {
    throw new Error('Invalid transcription chunk');
  }
};

/** Lazy iteration covers the entire duration, including its final partial window. */
export function* getTranscriptionChunks(
  durationMs: number,
  windowMs: number = TRANSCRIPTION_CHUNK_MS,
): Generator<TranscriptionChunk> {
  if (!isTimestamp(durationMs)) {
    throw new Error('Invalid transcription duration');
  }
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0 || windowMs > TRANSCRIPTION_CHUNK_MS) {
    throw new Error('Invalid transcription window');
  }
  for (let startMs = 0; startMs < durationMs;) {
    const length = Math.min(windowMs, durationMs - startMs);
    yield { startMs, durationMs: length };
    startMs += length;
  }
}

/** Treat model output as untrusted plain text, not WebVTT markup, settings, or cue identifiers. */
const normalizeText = (text: string) => {
  if (typeof text !== 'string' || text.length > MAX_CUE_TEXT_LENGTH) {
    throw new Error('Invalid transcription text');
  }
  return text
    .replaceAll(/\s+/g, ' ')
    .replaceAll(/\p{Cc}/gu, '')
    .trim();
};

/** Segment times are chunk-relative milliseconds. Clip to the requested window and add its offset once. */
export const normalizeTranscriptionSegments = (
  segments: TranscriptionSegment[],
  chunk: TranscriptionChunk,
): SubtitleCue[] => {
  validateTranscriptionChunk(chunk);
  if (!Array.isArray(segments) || segments.length > MAX_SEGMENTS_PER_CHUNK) {
    throw new Error('Invalid transcription segments');
  }
  const cues: SubtitleCue[] = [];
  for (const segment of segments) {
    if (
      !segment ||
      !Number.isFinite(segment.startMs) ||
      !Number.isFinite(segment.endMs) ||
      segment.endMs < segment.startMs
    ) {
      throw new Error('Invalid transcription segment timestamps');
    }
    const text = normalizeText(segment.text);
    const startMs = Math.max(0, Math.min(chunk.durationMs, Math.round(segment.startMs)));
    const endMs = Math.max(0, Math.min(chunk.durationMs, Math.round(segment.endMs)));
    if (text && endMs > startMs) {
      cues.push({ startMs: chunk.startMs + startMs, endMs: chunk.startMs + endMs, text });
    }
  }
  return cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
};

export const formatWebVttTimestamp = (milliseconds: number) => {
  if (!isTimestamp(milliseconds)) {
    throw new Error('Invalid subtitle timestamp');
  }
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds / 60_000) % 60;
  const seconds = Math.floor(milliseconds / 1000) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
};

/** Serialize one cue at a time so callers can stream to a temporary file and atomically publish on success. */
export const serializeWebVttCue = ({ startMs, endMs, text }: SubtitleCue): string => {
  if (!isTimestamp(startMs) || !isTimestamp(endMs) || endMs <= startMs) {
    throw new Error('Invalid subtitle cue interval');
  }
  const normalized = normalizeText(text);
  if (!normalized) {
    return '';
  }
  const escaped = normalized.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `${formatWebVttTimestamp(startMs)} --> ${formatWebVttTimestamp(endMs)}\n${escaped}\n\n`;
};
