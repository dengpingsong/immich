import type { AssetSubtitleResponseDto } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import { getSubtitleLabel, getSubtitleTrackUrl, hasPlayableSubtitles } from './subtitles';

const subtitle: AssetSubtitleResponseDto = {
  assetId: 'asset-id',
  language: 'zh',
  modelName: 'faster-whisper:tiny',
  cueCount: 3,
  droppedCueCount: 1,
  updatedAt: '2026-10-15T12:00:00.000Z',
};

describe('subtitle track url', () => {
  it('points at the asset subtitle track', () => {
    expect(getSubtitleTrackUrl('asset-id')).toBe('/api/assets/asset-id/subtitles.vtt');
  });

  it('carries shared link credentials because a track request cannot send headers', () => {
    expect(getSubtitleTrackUrl('asset-id', { key: 'shared-key', slug: 'share-slug' })).toBe(
      '/api/assets/asset-id/subtitles.vtt?key=shared-key&slug=share-slug',
    );
  });

  it('omits empty parameters and encodes the asset id', () => {
    expect(getSubtitleTrackUrl('a b/c', { key: '' })).toBe('/api/assets/a%20b%2Fc/subtitles.vtt');
  });
});

describe('subtitle availability', () => {
  it('only offers a track when there is at least one cue', () => {
    expect(hasPlayableSubtitles(subtitle)).toBe(true);
    expect(hasPlayableSubtitles({ ...subtitle, cueCount: 0 })).toBe(false);
    expect(hasPlayableSubtitles(undefined)).toBe(false);
  });

  it('labels the track with the detected language', () => {
    expect(getSubtitleLabel(subtitle)).toBe('zh');
    expect(getSubtitleLabel({ ...subtitle, language: '' })).toBe('faster-whisper:tiny');
  });
});
