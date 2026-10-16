import type { AssetSubtitleResponseDto } from '@immich/sdk';

export type AuthParams = { key?: string; slug?: string };

/**
 * URL of the generated WebVTT track for a player `<track>` element.
 *
 * A `<track src>` cannot send an Authorization header, so the same query parameters used by the media
 * URLs are appended here; that keeps shared links and session cookies equally working.
 */
export const getSubtitleTrackUrl = (assetId: string, params: AuthParams = {}) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      query.set(key, value);
    }
  }
  const serialized = query.toString();
  const suffix = serialized ? `?${serialized}` : '';
  return `/api/assets/${encodeURIComponent(assetId)}/subtitles.vtt${suffix}`;
};

/** A transcript with no cues must not offer an empty subtitle track in the player. */
export const hasPlayableSubtitles = (subtitle: AssetSubtitleResponseDto | undefined): boolean =>
  !!subtitle && subtitle.cueCount > 0;

/** Track label shown in the player, preferring the reported language over the model name. */
export const getSubtitleLabel = (subtitle: AssetSubtitleResponseDto) => subtitle.language || subtitle.modelName;
