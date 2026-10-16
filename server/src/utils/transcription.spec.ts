import {
  formatWebVttTimestamp,
  getTranscriptionChunks,
  normalizeTranscriptionSegments,
  serializeWebVttCue,
  validateTranscriptionChunk,
  WEBVTT_HEADER,
} from 'src/utils/transcription';

const chunk = { startMs: 30_000, durationMs: 30_000 };

describe('transcription chunks', () => {
  it('covers a long video completely, with a final partial chunk and no count cap', () => {
    const chunks = [...getTranscriptionChunks(10 * 3_600_000 + 123)];
    expect(chunks).toHaveLength(1201);
    expect(chunks[0]).toEqual({ startMs: 0, durationMs: 30_000 });
    expect(chunks.at(-1)).toEqual({ startMs: 36_000_000, durationMs: 123 });
    expect(chunks.reduce((total, value) => total + value.durationMs, 0)).toBe(36_000_123);
  });

  it('honours a caller-provided window and rejects unusable ones', () => {
    expect([...getTranscriptionChunks(7000, 5000)]).toEqual([
      { startMs: 0, durationMs: 5000 },
      { startMs: 5000, durationMs: 2000 },
    ]);
    expect([...getTranscriptionChunks(7000, 30_000)]).toEqual([{ startMs: 0, durationMs: 7000 }]);
    for (const window of [0, -1, 30_001, 1.5, Number.NaN]) {
      expect(() => getTranscriptionChunks(10_000, window).next()).toThrow('Invalid transcription window');
    }
  });

  it('is lazy and handles empty input without requesting an audio chunk', () => {
    expect([...getTranscriptionChunks(0)]).toEqual([]);
    const iterator = getTranscriptionChunks(Number.MAX_SAFE_INTEGER);
    expect(iterator.next().value).toEqual({ startMs: 0, durationMs: 30_000 });
    expect(iterator.next().value).toEqual({ startMs: 30_000, durationMs: 30_000 });
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid duration %s',
    (duration) => expect(() => getTranscriptionChunks(duration).next()).toThrow('Invalid transcription duration'),
  );

  it.each([
    { startMs: -1, durationMs: 1000 },
    { startMs: 0, durationMs: 0 },
    { startMs: 0, durationMs: 30_001 },
    { startMs: 0, durationMs: 1.1 },
    { startMs: Number.MAX_SAFE_INTEGER, durationMs: 1 },
  ])('rejects invalid or unbounded chunk %j', (value) => {
    expect(() => validateTranscriptionChunk(value)).toThrow('Invalid transcription chunk');
  });
});

describe('normalizeTranscriptionSegments', () => {
  it('adds the chunk offset exactly once and preserves silence between segments', () => {
    expect(
      normalizeTranscriptionSegments(
        [
          { startMs: 10_001, endMs: 12_002, text: '第二句话' },
          { startMs: 500, endMs: 1100, text: '  第一句话\n' },
        ],
        chunk,
      ),
    ).toEqual([
      { startMs: 30_500, endMs: 31_100, text: '第一句话' },
      { startMs: 40_001, endMs: 42_002, text: '第二句话' },
    ]);
  });

  it('clips model padding to the partial window and removes empty or out-of-window cues', () => {
    expect(
      normalizeTranscriptionSegments(
        [
          { startMs: -1, endMs: 250, text: 'start' },
          { startMs: 900, endMs: 30_000, text: 'end' },
          { startMs: 2000, endMs: 3000, text: 'padding' },
          { startMs: -2000, endMs: -1000, text: 'before' },
          { startMs: 200, endMs: 200, text: 'zero' },
          { startMs: 300, endMs: 400, text: ' \r\n\t' },
        ],
        { startMs: 60_000, durationMs: 1000 },
      ),
    ).toEqual([
      { startMs: 60_000, endMs: 60_250, text: 'start' },
      { startMs: 60_900, endMs: 61_000, text: 'end' },
    ]);
  });

  it('rounds sub-millisecond model timestamps instead of emitting fractional cues', () => {
    expect(normalizeTranscriptionSegments([{ startMs: 0.4, endMs: 1200.6, text: 'x' }], chunk)).toEqual([
      { startMs: 30_000, endMs: 31_201, text: 'x' },
    ]);
  });

  it('accepts no-speech results without inventing text', () => {
    expect(normalizeTranscriptionSegments([], chunk)).toEqual([]);
  });

  it.each([
    { startMs: Number.NaN, endMs: 1000, text: 'invalid' },
    { startMs: 0, endMs: Number.POSITIVE_INFINITY, text: 'invalid' },
    { startMs: 2000, endMs: 1000, text: 'reversed' },
  ])('rejects malformed model timestamps %j', (segment) => {
    expect(() => normalizeTranscriptionSegments([segment], chunk)).toThrow('Invalid transcription segment');
  });

  it('bounds per-chunk model output without imposing a full-video cue cap', () => {
    expect(() =>
      normalizeTranscriptionSegments(
        Array.from({ length: 1001 }, () => ({ startMs: 0, endMs: 1000, text: 'x' })),
        chunk,
      ),
    ).toThrow('Invalid transcription segments');
    expect(() =>
      normalizeTranscriptionSegments([{ startMs: 0, endMs: 1000, text: 'x'.repeat(16_385) }], chunk),
    ).toThrow('Invalid transcription text');
  });
});

describe('WebVTT serialization', () => {
  it.each([
    [0, '00:00:00.000'],
    [59_999, '00:00:59.999'],
    [60_000, '00:01:00.000'],
    [3_661_001, '01:01:01.001'],
    [100 * 3_600_000, '100:00:00.000'],
  ])('formats %s without date wrapping', (value, expected) => {
    expect(formatWebVttTimestamp(value)).toBe(expected);
  });

  it('streams an independently loadable WebVTT header and UTF-8 cue', () => {
    const cue = serializeWebVttCue({ startMs: 0, endMs: 1234, text: '你好，世界。مرحبا' });
    expect(WEBVTT_HEADER + cue).toBe('WEBVTT\n\n00:00:00.000 --> 00:00:01.234\n你好，世界。مرحبا\n\n');
  });

  it('escapes markup, timing arrows, entities, blank lines and control characters', () => {
    const text = '<v fake><script>x</script>&lrm;\r\n\r\n00:00:00.000 --> 99:00:00.000\nSTYLE\u{0}';
    expect(serializeWebVttCue({ startMs: 0, endMs: 1000, text })).toBe(
      '00:00:00.000 --> 00:00:01.000\n&lt;v fake&gt;&lt;script&gt;x&lt;/script&gt;&amp;lrm; 00:00:00.000 --&gt; 99:00:00.000 STYLE\n\n',
    );
  });

  it.each([-1, 1.5, NaN, Infinity])('rejects invalid cue timestamp %s', (value) => {
    expect(() => formatWebVttTimestamp(value)).toThrow('Invalid subtitle timestamp');
    expect(() => serializeWebVttCue({ startMs: value, endMs: 100, text: 'text' })).toThrow();
  });

  it('does not emit empty or zero-length cues', () => {
    expect(serializeWebVttCue({ startMs: 0, endMs: 100, text: ' \n ' })).toBe('');
    expect(() => serializeWebVttCue({ startMs: 0, endMs: 0, text: 'zero' })).toThrow();
  });
});
