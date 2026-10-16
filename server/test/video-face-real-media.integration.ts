import ffmpeg from 'fluent-ffmpeg';
import { readFileSync, writeFileSync } from 'node:fs';
import { MediaRepository } from 'src/repositories/media.repository';
import {
  aggregateVideoFaces,
  decodeFaceEmbedding,
  faceSimilarity,
  getVideoFaceSampleTimes,
  SampledFace,
} from 'src/utils/video-face';
import { describe, expect, it } from 'vitest';

// Opt-in only. All media/inference artifacts must be disposable copies, never production paths.
const root = process.env.IMMICH_REAL_MEDIA_ROOT;
const container = process.env.IMMICH_REAL_MEDIA_CONTAINER;
describe.skipIf(!root || !container)('isolated real HEIC / Live Photo media', () => {
  it('uses source extraction, sampling and aggregation with real local ML outputs', async () => {
    if (
      !root ||
      !container ||
      !root.startsWith('/tmp/immich-real-media-') ||
      !container.startsWith('immich-real-media-server-')
    ) {
      throw new Error('An explicitly isolated test root and container are required');
    }
    const metadata = JSON.parse(readFileSync(`${root}/metadata.json`, 'utf8'));
    const detections = JSON.parse(readFileSync(`${root}/detections.json`, 'utf8'));
    ffmpeg.setFfmpegPath(`${root}/ffmpeg-wrapper`);
    const media = Object.create(MediaRepository.prototype) as MediaRepository;
    const videoFaces = {
      enabled: true,
      intervalMs: 2000,
      livePhotoIntervalMs: 500,
      maxFrames: 30,
      minSimilarity: 0.55,
    };
    expect(videoFaces.enabled).toBe(true);
    const summary = [];
    for (const item of metadata) {
      expect(item.magic).toContain('ftypheic');
      expect(item.tagsH.ContentIdentifier).toBe(item.tagsM.ContentIdentifier);
      expect(
        getVideoFaceSampleTimes(
          Number(item.probe.format.duration) * 1000,
          videoFaces.livePhotoIntervalMs,
          videoFaces.maxFrames,
        ),
      ).toEqual(item.times);
      const candidates: SampledFace[] = [];
      const itemDetections = detections.filter((entry: any) => entry.file.startsWith(`${item.stem}-`));
      for (const result of itemDetections) {
        const suffix = result.file.slice(item.stem.length + 1, -4);
        const timestampMs = suffix === 'still' ? null : Number(suffix);
        if (timestampMs !== null) {
          const frame = await media.extractVideoFaceFrame(`/test/media/${item.stem}.MOV`, timestampMs);
          // Same frame bytes used for inference and later representative thumbnails.
          expect(frame.equals(readFileSync(`${root}/output/${result.file}`))).toBe(true);
        }
        candidates.push(
          ...result.faces.map((face: any) => ({
            ...face,
            timestampMs,
            imageWidth: result.imageWidth,
            imageHeight: result.imageHeight,
          })),
        );
      }
      const groups = aggregateVideoFaces(candidates, videoFaces.minSimilarity);
      const anonymous = groups.map((group, index) => {
        expect(new Set(group.appearances.map((appearance) => appearance.timestampMs)).size).toBe(
          group.appearances.length,
        );
        const representative = candidates.find((face) => face.embedding === group.embedding)!;
        expect(representative.timestampMs).toBe(group.timestampMs);
        return {
          id: `G${index + 1}`,
          representativeMs: group.timestampMs,
          appearances: group.appearances.map((a) => a.timestampMs),
          similarities: candidates
            .filter(
              (c) =>
                c === representative ||
                group.appearances.some(
                  (a) =>
                    a.timestampMs === c.timestampMs &&
                    a.boundingBoxX1 === c.boundingBox.x1 &&
                    a.boundingBoxY1 === c.boundingBox.y1,
                ),
            )
            .map((c) =>
              Number(faceSimilarity(decodeFaceEmbedding(group.embedding), decodeFaceEmbedding(c.embedding)).toFixed(4)),
            ),
        };
      });
      summary.push({
        stem: item.stem,
        raw: candidates.length,
        dedup: groups.length,
        byFrame: detections
          .filter((d: any) => d.file.startsWith(item.stem))
          .map((d: any) => ({ file: d.file, count: d.faces.length, width: d.imageWidth, height: d.imageHeight })),
        groups: anonymous,
      });
    }
    writeFileSync(`${root}/summary.json`, JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
  }, 120_000);
});
