import { getAssetInfo, type AssetResponseDto } from '@immich/sdk';
import type { ZoomImageWheelState } from '@zoom-image/core';
import { cubicOut } from 'svelte/easing';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { userPreferencesManager } from '$lib/managers/user-preferences-manager.svelte';
import type { ImageLoaderStatus } from '$lib/utils/adaptive-image-loader.svelte';
import { canCopyImageToClipboard } from '$lib/utils/asset-utils';
import { BaseEventManager } from '$lib/utils/base-event-manager.svelte';
import type { AssetGridRouteSearchParams } from '$lib/utils/navigation';

export interface Faces {
  /** Temporal coordinates belong to a sampled video frame, not the static preview. */
  timestampMs?: number | null;
  id: string;
  imageHeight: number;
  imageWidth: number;
  boundingBoxX1: number;
  boundingBoxX2: number;
  boundingBoxY1: number;
  boundingBoxY2: number;
}

const createDefaultZoomState = (): ZoomImageWheelState => ({
  currentRotation: 0,
  currentZoom: 1,
  enable: true,
  currentPositionX: 0,
  currentPositionY: 0,
});

export type Events = {
  Zoom: [];
  ZoomChange: [ZoomImageWheelState];
  Copy: [];
  FaceEditModeChange: [boolean];
};

class AssetViewerManager extends BaseEventManager<Events> {
  #zoomState = $state(createDefaultZoomState());
  #animationFrameId: number | null = null;

  imgRef = $state<HTMLImageElement | undefined>();
  imageLoaderStatus = $state<ImageLoaderStatus | undefined>();
  #isImageLoading = $derived.by(() => {
    const quality = this.imageLoaderStatus?.quality;
    if (!quality || this.imageLoaderStatus?.hasError) {
      return false;
    }
    const previewOrOriginalReady = quality.preview === 'success' || quality.original === 'success';
    const loadingOriginal = this.zoom > 1 && quality.original !== 'success';
    return !previewOrOriginalReady || loadingOriginal;
  });
  isShowActivityPanel = $state(false);
  isPlayingMotionPhoto = $state(false);
  isShowEditor = $state(false);
  #isFaceEditMode = $state(false);
  #isEditFacesPanelOpen = $state(false);
  #viewingAssetStoreState = $state<AssetResponseDto>();
  #viewState = $state<boolean>(false);
  #hoveredFaces = $state<Faces[]>([]);
  #selectedFaces = $state<Faces[]>([]);
  #hoveredMarkers = $state<number[]>([]);
  #selectedMarkers = $state<number[]>([]);
  #showingHiddenPeople = $state(false);
  gridScrollTarget = $state<AssetGridRouteSearchParams | null | undefined>();

  get asset() {
    return this.#viewingAssetStoreState;
  }

  get isViewing() {
    return this.#viewState;
  }

  get isImageLoading() {
    return this.#isImageLoading;
  }

  get isShowDetailPanel() {
    return userPreferencesManager.showDetailPanel;
  }

  get isShowAssetPath() {
    return userPreferencesManager.showAssetPath;
  }

  get isFaceEditMode() {
    return this.#isFaceEditMode;
  }

  get isEditFacesPanelOpen() {
    return this.#isEditFacesPanelOpen;
  }

  get zoomState() {
    return this.#zoomState;
  }

  set zoomState(state: ZoomImageWheelState) {
    this.#zoomState = state;
    this.emit('ZoomChange', state);
  }

  get zoom() {
    return this.#zoomState.currentZoom;
  }

  set zoom(zoom: number) {
    this.cancelZoomAnimation();
    this.zoomState = { ...this.zoomState, currentZoom: zoom };
  }

  canZoomIn() {
    return this.hasListeners('Zoom') && this.zoom <= 1;
  }

  canZoomOut() {
    return this.hasListeners('Zoom') && this.zoom > 1;
  }

  canCopyImage() {
    return canCopyImageToClipboard() && !!assetViewerManager.imgRef;
  }

  private set isShowDetailPanel(value: boolean) {
    userPreferencesManager.showDetailPanel = value;
  }

  private set isShowAssetPath(value: boolean) {
    userPreferencesManager.showAssetPath = value;
  }

  onZoomChange(state: ZoomImageWheelState) {
    // bypass event emitter to avoid loop
    this.#zoomState = state;
  }

  cancelZoomAnimation() {
    if (this.#animationFrameId === null) {
      return;
    }

    cancelAnimationFrame(this.#animationFrameId);
    this.#animationFrameId = null;
  }

  animatedZoom(targetZoom: number, duration = 300) {
    this.cancelZoomAnimation();

    const startZoom = this.#zoomState.currentZoom;
    const startTime = performance.now();

    const frame = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const linearProgress = Math.min(elapsed / duration, 1);
      const easedProgress = cubicOut(linearProgress);
      const interpolatedZoom = startZoom + (targetZoom - startZoom) * easedProgress;

      this.zoomState = { ...this.#zoomState, currentZoom: interpolatedZoom };

      this.#animationFrameId = linearProgress < 1 ? requestAnimationFrame(frame) : null;
    };

    this.#animationFrameId = requestAnimationFrame(frame);
  }

  resetZoomState() {
    this.cancelZoomAnimation();
    this.zoomState = createDefaultZoomState();
  }

  toggleActivityPanel() {
    this.closeDetailPanel();
    this.isShowActivityPanel = !this.isShowActivityPanel;
  }

  closeActivityPanel() {
    this.isShowActivityPanel = false;
  }

  toggleAssetPath() {
    this.isShowAssetPath = !this.isShowAssetPath;
  }

  toggleDetailPanel() {
    this.closeActivityPanel();
    this.isShowDetailPanel = !this.isShowDetailPanel;
  }

  closeDetailPanel() {
    this.isShowDetailPanel = false;
  }

  openEditor() {
    this.closeActivityPanel();
    this.isShowEditor = true;
  }

  closeEditor() {
    this.isShowEditor = false;
  }

  toggleFaceEditMode() {
    this.#isFaceEditMode = !this.#isFaceEditMode;
    this.emit('FaceEditModeChange', this.#isFaceEditMode);
  }

  closeFaceEditMode() {
    if (this.#isFaceEditMode) {
      this.emit('FaceEditModeChange', false);
    }
    this.#isFaceEditMode = false;
  }

  openEditFacesPanel() {
    this.#isEditFacesPanelOpen = true;
  }

  closeEditFacesPanel() {
    this.#isEditFacesPanelOpen = false;
  }

  resetPanelState() {
    this.closeEditor();
    this.closeFaceEditMode();
    this.closeEditFacesPanel();
  }

  // Hovering a portrait is transient, while clicking one selects it until something else is selected.
  // Both used to share a single value, so the viewer clearing its hover highlight (on pointer leave) also
  // wiped the person the user had just clicked. Hover wins while it lasts, the selection is the fallback.
  get highlightedFaces() {
    return this.#hoveredFaces.length > 0 ? this.#hoveredFaces : this.#selectedFaces;
  }

  /** Transient highlight, used for hover. */
  setHighlightedFaces(faces: Faces[]) {
    this.#hoveredFaces = faces;
  }

  /** Sticky selection, used for clicks and keyboard focus. */
  selectFaces(faces: Faces[]) {
    this.#selectedFaces = faces;
  }

  get selectedFaces() {
    return this.#selectedFaces;
  }

  /** Clears only the transient highlight, so a clicked person stays highlighted. */
  clearHighlightedFaces() {
    this.#hoveredFaces = [];
  }

  clearSelectedFaces() {
    this.#selectedFaces = [];
    this.#hoveredFaces = [];
  }

  /** Sample instants of the highlighted person, drawn as marks on the native seek range. */
  get faceSampleMarkers() {
    return this.#hoveredMarkers.length > 0 ? this.#hoveredMarkers : this.#selectedMarkers;
  }

  setFaceSampleMarkers(timestamps: number[]) {
    this.#hoveredMarkers = timestamps;
  }

  selectFaceSampleMarkers(timestamps: number[]) {
    this.#selectedMarkers = timestamps;
  }

  clearFaceSampleMarkers() {
    this.#hoveredMarkers = [];
  }

  clearSelectedFaceSampleMarkers() {
    this.#selectedMarkers = [];
    this.#hoveredMarkers = [];
  }

  get isShowingHiddenPeople() {
    return this.#showingHiddenPeople;
  }

  toggleHiddenPeople() {
    this.#showingHiddenPeople = !this.#showingHiddenPeople;
  }

  hideHiddenPeople() {
    this.#showingHiddenPeople = false;
  }

  setAsset(asset: AssetResponseDto) {
    this.#viewingAssetStoreState = asset;
    this.#viewState = true;
  }

  async setAssetId(id: string): Promise<AssetResponseDto> {
    const asset = await getAssetInfo({ ...authManager.params, id });
    this.setAsset(asset);
    return asset;
  }

  showAssetViewer(show: boolean) {
    this.#viewState = show;
  }
}

export const assetViewerManager = new AssetViewerManager();
