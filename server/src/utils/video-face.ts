import type { Face } from 'src/repositories/machine-learning.repository';

export interface FaceAppearance {
  timestampMs: number;
  imageWidth: number;
  imageHeight: number;
  boundingBoxX1: number;
  boundingBoxY1: number;
  boundingBoxX2: number;
  boundingBoxY2: number;
}

export interface SampledFace extends Face {
  timestampMs: number | null;
  imageWidth: number;
  imageHeight: number;
}

export interface AggregatedFace extends SampledFace {
  appearances: FaceAppearance[];
}

/** Sample the whole video at a fixed interval by default; zero means no frame cap. */
export function getVideoFaceSampleTimes(durationMs: number, intervalMs: number, maxFrames = 0): number[] {
  if (
    !Number.isFinite(durationMs) ||
    durationMs <= 0 ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0 ||
    !Number.isSafeInteger(maxFrames) ||
    maxFrames < 0
  ) {
    throw new Error('Invalid video face sampling options');
  }
  const count =
    maxFrames === 0 ? Math.ceil(durationMs / intervalMs) : Math.min(maxFrames, Math.ceil(durationMs / intervalMs));
  const step = maxFrames === 0 ? intervalMs : Math.max(intervalMs, durationMs / maxFrames);
  return Array.from({ length: count }, (_, index) => Math.floor(index * step));
}

/** ML uses JSON-serialized vectors. Normalize defensively rather than assuming unit length. */
export function decodeFaceEmbedding(embedding: string): number[] {
  const values: unknown = JSON.parse(embedding);
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some((value) => !(typeof value === 'number' && Number.isFinite(value)))
  ) {
    throw new Error('Invalid face embedding');
  }
  const norm = Math.hypot(...values);
  if (norm === 0 || !Number.isFinite(norm)) {
    throw new Error('Invalid face embedding norm');
  }
  return values.map((value: number) => value / norm);
}

export function faceSimilarity(a: number[], b: number[]): number {
  return a.length === b.length ? a.reduce((sum, value, index) => sum + value * b[index], 0) : -1;
}

/** Keep the best representative; never merge two detections from the same frame. */
export function aggregateVideoFaces(candidates: SampledFace[], threshold = 0.55): AggregatedFace[] {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error('Invalid face similarity threshold');
  }
  const quality = (face: SampledFace) =>
    (face.score *
      Math.max(0, face.boundingBox.x2 - face.boundingBox.x1) *
      Math.max(0, face.boundingBox.y2 - face.boundingBox.y1)) /
    (face.imageWidth * face.imageHeight);
  const groups: { face: AggregatedFace; vector: number[]; times: Set<number | null> }[] = [];
  for (const candidate of [...candidates].sort((a, b) => quality(b) - quality(a))) {
    const vector = decodeFaceEmbedding(candidate.embedding);
    let best: (typeof groups)[number] | undefined;
    let bestSimilarity = threshold;
    for (const group of groups) {
      const similarity = faceSimilarity(group.vector, vector);
      if (!group.times.has(candidate.timestampMs) && similarity >= bestSimilarity) {
        best = group;
        bestSimilarity = similarity;
      }
    }
    if (!best) {
      best = { face: { ...candidate, appearances: [] }, vector, times: new Set() };
      groups.push(best);
    }
    best.times.add(candidate.timestampMs);
    if (candidate.timestampMs !== null) {
      best.face.appearances.push({
        timestampMs: candidate.timestampMs,
        imageWidth: candidate.imageWidth,
        imageHeight: candidate.imageHeight,
        boundingBoxX1: candidate.boundingBox.x1,
        boundingBoxY1: candidate.boundingBox.y1,
        boundingBoxX2: candidate.boundingBox.x2,
        boundingBoxY2: candidate.boundingBox.y2,
      });
    }
  }
  return groups.map(({ face }) => ({
    ...face,
    appearances: face.appearances.sort((a, b) => a.timestampMs - b.timestampMs),
  }));
}
