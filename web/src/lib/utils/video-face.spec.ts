import { describe, expect, it } from 'vitest';
import {
  formatFaceSampleTime,
  getContainedVideoSize,
  getFaceMarkerPositions,
  getFaceSampleAt,
  getFaceSampleTimes,
  parseFaceSampleMarkers,
  serializeFaceSampleMarkers,
} from './video-face';

const sample = {
  timestampMs: 2000,
  imageWidth: 1920,
  imageHeight: 1080,
  boundingBoxX1: 10,
  boundingBoxY1: 20,
  boundingBoxX2: 50,
  boundingBoxY2: 60,
};

describe('video face timeline', () => {
  it('shows a sampled box only close to that instant', () => {
    expect(getFaceSampleAt([sample], 2)).toEqual(sample);
    expect(getFaceSampleAt([sample], 2.1)).toEqual(sample);
    expect(getFaceSampleAt([sample], 3)).toBeUndefined();
    expect(getFaceSampleAt([sample], NaN)).toBeUndefined();
  });
  it('fits landscape and portrait videos without stretching boxes into letterboxing', () => {
    expect(getContainedVideoSize(1000, 1000, 1920, 1080).width).toBeCloseTo(1000);
    expect(getContainedVideoSize(1000, 1000, 1920, 1080).height).toBeCloseTo(562.5);
    expect(getContainedVideoSize(1000, 1000, 1080, 1920).width).toBeCloseTo(562.5);
    expect(getContainedVideoSize(1000, 1000, 1080, 1920).height).toBeCloseTo(1000);
    expect(getContainedVideoSize(1000, 1000, 0, 0)).toEqual({ width: 0, height: 0 });
  });
  it('formats timestamps including milliseconds and long durations', () => {
    expect(formatFaceSampleTime(0)).toBe('0:00.000');
    expect(formatFaceSampleTime(2500)).toBe('0:02.500');
    expect(formatFaceSampleTime(3_601_001)).toBe('60:01.001');
    // Playback positions are floats; never leak float noise into the UI.
    expect(formatFaceSampleTime(2481.489999999999)).toBe('0:02.481');
    expect(formatFaceSampleTime(999.6)).toBe('0:01.000');
    expect(formatFaceSampleTime(-5)).toBe('0:00.000');
  });
  it("lists one person's sample instants once, sorted, across their faces", () => {
    expect(
      getFaceSampleTimes([
        { appearances: [sample, { ...sample, timestampMs: 0 }] },
        { appearances: [sample, { ...sample, timestampMs: 500 }] },
      ]),
    ).toEqual([0, 500, 2000]);
    expect(getFaceSampleTimes([{ appearances: [] }, {}])).toEqual([]);
    expect(getFaceSampleTimes([{ appearances: null }, { appearances: undefined }])).toEqual([]);
  });
  it('round-trips marker attributes for the native seek range', () => {
    expect(serializeFaceSampleMarkers([2000, 0, 500])).toBe('2000,0,500');
    expect(serializeFaceSampleMarkers([])).toBe('');
    // Attribute order and duplicates must not depend on how the value was written.
    expect(parseFaceSampleMarkers('2000,0,500,0')).toEqual([0, 500, 2000]);
    expect(parseFaceSampleMarkers('')).toEqual([]);
    expect(parseFaceSampleMarkers(undefined)).toEqual([]);
    expect(parseFaceSampleMarkers('abc')).toEqual([]);
    expect(parseFaceSampleMarkers('-5,NaN,100')).toEqual([100]);
  });
  it('places markers as percentages of the real duration and clamps out-of-range samples', () => {
    expect(getFaceMarkerPositions([0, 1000, 2000], 2000)).toEqual([
      { timestampMs: 0, percent: 0 },
      { timestampMs: 1000, percent: 50 },
      { timestampMs: 2000, percent: 100 },
    ]);
    // A sample beyond the media must stay visible at the end instead of vanishing.
    expect(getFaceMarkerPositions([5000], 2000)).toEqual([{ timestampMs: 5000, percent: 100 }]);
    expect(getFaceMarkerPositions([100], 0)).toEqual([]);
    expect(getFaceMarkerPositions([100], NaN)).toEqual([]);
    expect(getFaceMarkerPositions([100], Infinity)).toEqual([]);
    expect(getFaceMarkerPositions([], 2000)).toEqual([]);
  });
});
