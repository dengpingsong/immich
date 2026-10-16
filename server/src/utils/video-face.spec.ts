import { aggregateVideoFaces, decodeFaceEmbedding, getVideoFaceSampleTimes, SampledFace } from 'src/utils/video-face';
import { describe, expect, it } from 'vitest';

const face = (timestampMs: number | null, overrides: Partial<SampledFace> = {}): SampledFace => ({
  timestampMs,
  imageWidth: 100,
  imageHeight: 100,
  boundingBox: { x1: 10, y1: 10, x2: 30, y2: 30 },
  embedding: '[1,0,0]',
  score: 0.9,
  ...overrides,
});

describe('video face sampling', () => {
  it('samples short videos and Live Photos at the requested interval', () => {
    expect(getVideoFaceSampleTimes(1100, 500, 8)).toEqual([0, 500, 1000]);
    expect(getVideoFaceSampleTimes(100, 2000, 30)).toEqual([0]);
  });
  it('keeps fixed interval coverage for an entire long video by default', () => {
    const times = getVideoFaceSampleTimes(3_600_000, 2000);
    expect(times).toHaveLength(1800);
    expect(times[1799]).toBe(3_598_000);
    expect(times.every((time, index) => time === index * 2000)).toBe(true);
    expect(getVideoFaceSampleTimes(1100, 500, 0)).toEqual([0, 500, 1000]);
  });
  it('spreads bounded samples across long videos only when explicitly capped', () => {
    const times = getVideoFaceSampleTimes(600_000, 2000, 30);
    expect(times).toHaveLength(30);
    expect(times[29]).toBe(580_000);
    expect(getVideoFaceSampleTimes(6000, 2000, 30)).toEqual([0, 2000, 4000]);
  });
  it('rejects invalid options', () => {
    for (const duration of [0, -1, NaN, Infinity]) {
      expect(() => getVideoFaceSampleTimes(duration, 2000, 30)).toThrow();
    }
    expect(() => getVideoFaceSampleTimes(1000, 0, 30)).toThrow();
    expect(() => getVideoFaceSampleTimes(1000, 500, 1.5)).toThrow();
  });
});

describe('video face aggregation', () => {
  it('keeps the best representative and chronological per-frame coordinates', () => {
    const result = aggregateVideoFaces([face(2000), face(0, { score: 1 }), face(4000)]);
    expect(result).toHaveLength(1);
    expect(result[0].timestampMs).toBe(0);
    expect(result[0].appearances.map((point) => point.timestampMs)).toEqual([0, 2000, 4000]);
  });
  it('aggregates still and motion faces without inventing a still timestamp', () => {
    const result = aggregateVideoFaces([face(null, { score: 1 }), face(500)]);
    expect(result[0].timestampMs).toBeNull();
    expect(result[0].appearances).toHaveLength(1);
  });
  it('keeps different people and same-frame detections separate', () => {
    expect(aggregateVideoFaces([face(0), face(2000, { embedding: '[0,1,0]' })])).toHaveLength(2);
    expect(aggregateVideoFaces([face(0), face(0)])).toHaveLength(2);
  });
  it('normalizes embeddings and rejects malformed vectors', () => {
    expect(decodeFaceEmbedding('[3,4]')).toEqual([0.6, 0.8]);
    for (const embedding of ['[]', '[0,0]', '[null]', '{}', 'invalid']) {
      expect(() => decodeFaceEmbedding(embedding)).toThrow();
    }
  });
  it('retains each source frame dimensions for Live Photo coordinate mapping', () => {
    const result = aggregateVideoFaces([face(null), face(500, { imageWidth: 200, imageHeight: 300 })]);
    expect(result[0].appearances[0]).toMatchObject({ imageWidth: 200, imageHeight: 300 });
  });
});
