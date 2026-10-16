import type { AssetFaceResponseDto } from '@immich/sdk';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { vi } from 'vitest';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import VideoFaceTimeline from './VideoFaceTimeline.svelte';

const { getAssetFaces } = vi.hoisted(() => ({ getAssetFaces: vi.fn() }));
vi.mock('$lib/managers/AssetCacheManager.svelte', () => ({ assetCacheManager: { getAssetFaces } }));

const face: AssetFaceResponseDto = {
  id: 'face',
  person: null,
  sourceAssetId: 'motion',
  timestampMs: 2500,
  imageWidth: 100,
  imageHeight: 100,
  boundingBoxX1: 10,
  boundingBoxY1: 10,
  boundingBoxX2: 30,
  boundingBoxY2: 30,
  appearances: [
    {
      timestampMs: 2500,
      imageWidth: 100,
      imageHeight: 100,
      boundingBoxX1: 10,
      boundingBoxY1: 10,
      boundingBoxX2: 30,
      boundingBoxY2: 30,
    },
  ],
};

const createPlayer = () => {
  const player = document.createElement('video');
  vi.spyOn(player, 'pause').mockImplementation(() => {});
  return player;
};

describe('VideoFaceTimeline', () => {
  beforeEach(() => {
    getAssetFaces.mockReset();
    assetViewerManager.clearHighlightedFaces();
    assetViewerManager.clearFaceSampleMarkers();
  });

  it('highlights samples on hover/focus without seeking and links to the person library', async () => {
    const assigned = { ...face, person: { id: 'person-id', name: 'Demo' } } as AssetFaceResponseDto;
    getAssetFaces.mockResolvedValue([assigned, { ...assigned, id: 'second-face' }]);
    const player = createPlayer();
    Object.defineProperty(player, 'duration', { value: 10 });
    player.currentTime = 1;
    render(VideoFaceTimeline, { assetId: 'still', sourceAssetId: 'motion', player });
    const toggle = await screen.findByRole('button');
    expect(getAssetFaces).toHaveBeenCalledWith('still');
    await fireEvent.click(toggle);
    const link = screen.getByRole('link', { name: 'Demo' });
    expect(link).toHaveAttribute('href', '/people/person-id');
    expect(screen.getAllByRole('link')).toHaveLength(1);
    // Marks live on the native seek range, not on a separate bar inside this overlay.
    expect(assetViewerManager.faceSampleMarkers).toEqual([]);
    await fireEvent.mouseEnter(link);
    expect(assetViewerManager.faceSampleMarkers).toEqual([2500]);
    await fireEvent.mouseLeave(link);
    expect(assetViewerManager.faceSampleMarkers).toEqual([]);
    await fireEvent.focus(link);
    expect(assetViewerManager.faceSampleMarkers).toEqual([2500]);
    await fireEvent.blur(link);
    expect(assetViewerManager.faceSampleMarkers).toEqual([]);
    expect(player.pause).not.toHaveBeenCalled();
    expect(player.currentTime).toBe(1);
    expect(screen.queryByRole('button', { name: /0:02.500/ })).not.toBeInTheDocument();
  });

  it('reacts to detail-panel portrait highlighting while its own panel remains collapsed', async () => {
    getAssetFaces.mockResolvedValue([face]);
    const player = createPlayer();
    Object.defineProperty(player, 'duration', { value: 10 });
    player.currentTime = 1;
    render(VideoFaceTimeline, { assetId: 'still', sourceAssetId: 'motion', player });
    const toggle = await screen.findByRole('button');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    assetViewerManager.setHighlightedFaces([face]);
    await waitFor(() => expect(assetViewerManager.faceSampleMarkers).toEqual([2500]));
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(player.currentTime).toBe(1);
    expect(player.pause).not.toHaveBeenCalled();
    assetViewerManager.clearHighlightedFaces();
    await waitFor(() => expect(assetViewerManager.faceSampleMarkers).toEqual([]));
  });

  it('ignores unrelated or stale portrait selections', async () => {
    getAssetFaces.mockResolvedValue([face]);
    const player = createPlayer();
    Object.defineProperty(player, 'duration', { value: 10 });
    render(VideoFaceTimeline, { assetId: 'still', sourceAssetId: 'motion', player });
    await screen.findByRole('button');
    assetViewerManager.setHighlightedFaces([{ ...face, id: 'other-face' }]);
    await fireEvent(player, new Event('timeupdate'));
    expect(assetViewerManager.faceSampleMarkers).toEqual([]);
  });

  it('explains an empty highlight when the current time has no detection for that person', async () => {
    const assigned = { ...face, person: { id: 'person-id', name: 'Demo' } } as AssetFaceResponseDto;
    getAssetFaces.mockResolvedValue([assigned]);
    const player = createPlayer();
    Object.defineProperty(player, 'duration', { value: 10 });
    player.currentTime = 5;
    const { container } = render(VideoFaceTimeline, { assetId: 'still', sourceAssetId: 'motion', player });
    await fireEvent.click(await screen.findByRole('button'));
    const link = screen.getByRole('link', { name: 'Demo' });
    await fireEvent.mouseEnter(link);
    // The native seek range still carries the detection instants...
    expect(assetViewerManager.faceSampleMarkers).toEqual([2500]);
    // ...but no box is invented for a frame that was never sampled.
    expect(container.querySelectorAll('.border-yellow-400')).toHaveLength(0);
    expect(container.querySelector('[data-face-no-sample]')).toBeInTheDocument();
    expect(player.pause).not.toHaveBeenCalled();
    expect(player.currentTime).toBe(5);
  });

  it('hides the empty-highlight explanation at a sampled instant', async () => {
    const assigned = { ...face, person: { id: 'person-id', name: 'Demo' } } as AssetFaceResponseDto;
    getAssetFaces.mockResolvedValue([assigned]);
    const player = createPlayer();
    Object.defineProperty(player, 'duration', { value: 10 });
    player.currentTime = 2.5;
    const { container } = render(VideoFaceTimeline, { assetId: 'still', sourceAssetId: 'motion', player });
    await fireEvent.click(await screen.findByRole('button'));
    await fireEvent.mouseEnter(screen.getByRole('link', { name: 'Demo' }));
    expect(container.querySelector('[data-face-no-sample]')).not.toBeInTheDocument();
    expect(assetViewerManager.faceSampleMarkers).toEqual([2500]);
    // The box itself needs layout sizes, which jsdom does not provide; only the chip logic is asserted here.
    player.currentTime = 4;
    await fireEvent(player, new Event('timeupdate'));
    await waitFor(() => expect(container.querySelector('[data-face-no-sample]')).toBeInTheDocument());
  });

  it('does not invent a person link or seek for unassigned faces', async () => {
    getAssetFaces.mockResolvedValue([face]);
    const player = createPlayer();
    render(VideoFaceTimeline, { assetId: 'still', sourceAssetId: 'motion', player });
    await fireEvent.click(await screen.findByRole('button'));
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    await fireEvent.click(screen.getAllByRole('button')[1]);
    expect(player.pause).not.toHaveBeenCalled();
    expect(player.currentTime).toBe(0);
  });

  it('does not show samples for an obsolete motion asset', async () => {
    getAssetFaces.mockResolvedValue([face]);
    render(VideoFaceTimeline, { assetId: 'still', sourceAssetId: 'replacement', player: createPlayer() });
    await waitFor(() => expect(getAssetFaces).toHaveBeenCalled());
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('ignores a delayed response after switching assets', async () => {
    let resolveOld!: (faces: AssetFaceResponseDto[]) => void;
    getAssetFaces
      .mockReturnValueOnce(
        new Promise<AssetFaceResponseDto[]>((resolve) => {
          resolveOld = resolve;
        }),
      )
      .mockResolvedValueOnce([]);
    const player = createPlayer();
    const { rerender } = render(VideoFaceTimeline, { assetId: 'old', sourceAssetId: 'motion', player });
    await waitFor(() => expect(getAssetFaces).toHaveBeenCalledWith('old'));
    await rerender({ assetId: 'new', sourceAssetId: 'motion', player });
    resolveOld([face]);
    await waitFor(() => expect(getAssetFaces).toHaveBeenCalledWith('new'));
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('does not break playback when optional face metadata fails', async () => {
    getAssetFaces.mockRejectedValue(new Error('Forbidden'));
    const player = createPlayer();
    render(VideoFaceTimeline, { assetId: 'still', sourceAssetId: 'motion', player });
    await waitFor(() => expect(getAssetFaces).toHaveBeenCalled());
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(player.pause).not.toHaveBeenCalled();
  });
});
