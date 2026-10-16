import type { FaceAppearanceDto } from '@immich/sdk';

/** Only show boxes close to a sampled instant; never interpolate identities. */
export const getFaceSampleAt = (appearances: FaceAppearanceDto[], seconds: number) => {
  if (!Number.isFinite(seconds)) {
    return;
  }
  return appearances.find((sample) => Math.abs(sample.timestampMs - seconds * 1000) <= 120);
};

/** Deduplicated, ordered sample instants for one person's faces, including faces stored on other frames. */
export const getFaceSampleTimes = (faces: { appearances?: FaceAppearanceDto[] | null }[]): number[] =>
  [...new Set(faces.flatMap((face) => (face.appearances ?? []).map((sample) => sample.timestampMs)))].sort(
    (a, b) => a - b,
  );

/** Serialize sample instants for the `face-markers` attribute of the native seek range. */
export const serializeFaceSampleMarkers = (timestamps: number[]): string =>
  timestamps.filter((timestamp) => Number.isFinite(timestamp) && timestamp >= 0).join(',');

/** Parse the attribute back to ordered, deduplicated instants; invalid input yields no markers. */
export const parseFaceSampleMarkers = (value: string | null | undefined): number[] => {
  if (!value) {
    return [];
  }
  const parsed = value
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp >= 0);
  return [...new Set(parsed)].sort((a, b) => a - b);
};

/** Percent offsets along the native seek range; samples outside the media are clamped, never dropped. */
export const getFaceMarkerPositions = (
  timestamps: number[],
  durationMs: number,
): { timestampMs: number; percent: number }[] => {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return [];
  }
  return timestamps.map((timestampMs) => ({
    timestampMs,
    percent: Math.min(100, Math.max(0, (timestampMs / durationMs) * 100)),
  }));
};

export const getContainedVideoSize = (width: number, height: number, videoWidth: number, videoHeight: number) => {
  if (Math.min(width, height, videoWidth, videoHeight) <= 0) {
    return { width: 0, height: 0 };
  }
  const scale = Math.min(width / videoWidth, height / videoHeight);
  return { width: videoWidth * scale, height: videoHeight * scale };
};

export const formatFaceSampleTime = (timestampMs: number) => {
  // Live playback times are floats; round once so `currentTime * 1000` cannot print 1489999999989.
  const time = Math.max(0, Math.round(timestampMs));
  const minutes = Math.floor(time / 60_000);
  const seconds = Math.floor(time / 1000) % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(time % 1000).padStart(3, '0')}`;
};
