import { MediaUIEvents, MediaUIAttributes } from 'media-chrome/constants';
import MediaTimeRange from 'media-chrome/media-time-range';
import { getFaceMarkerPositions, parseFaceSampleMarkers } from '$lib/utils/video-face';

const COMMIT_DELAY_MS = 750;

/** Attribute carrying the highlighted person's sampled instants, in milliseconds. */
export const FACE_MARKERS_ATTRIBUTE = 'face-markers';
const FACE_MARKERS_LABEL_ATTRIBUTE = 'face-markers-label';
const MARKER_LAYER_ID = 'face-markers';

/** Custom MediaTimeRange that only seeks after pointer release to avoid hammering the server.
 * Keyboard input uses timed debouncing instead since there's no release event.
 *
 * It also draws face-detection samples directly on the native track. Marking the real seek range
 * keeps the marks aligned with the playhead and hides them together with the player controls,
 * unlike a separate bar that could stay behind or drift out of alignment.
 */
class ImmichTimeRange extends MediaTimeRange {
  private seeking = false;
  private pending: number | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  static override get observedAttributes() {
    return [...MediaTimeRange.observedAttributes, FACE_MARKERS_ATTRIBUTE, FACE_MARKERS_LABEL_ATTRIBUTE];
  }

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener('pointerdown', this.hold);
    this.addEventListener('keydown', this.hold);
    this.addEventListener('pointerup', this.release);
    this.addEventListener('pointercancel', this.release);
    this.addEventListener(MediaUIEvents.MEDIA_SEEK_REQUEST, this.intercept, { capture: true });
    this.renderFaceMarkers();
  }

  override disconnectedCallback() {
    this.shadowRoot?.querySelector(`#${MARKER_LAYER_ID}`)?.remove();
    super.disconnectedCallback();
  }

  override attributeChangedCallback(attrName: string, oldValue: string | null, newValue: string | null) {
    super.attributeChangedCallback(attrName, oldValue, newValue);
    if (attrName === FACE_MARKERS_ATTRIBUTE || attrName === FACE_MARKERS_LABEL_ATTRIBUTE) {
      if (oldValue !== newValue) {
        this.renderFaceMarkers();
      }
      return;
    }
    // Marks are stored as percentages, so they must be recomputed when the duration becomes known.
    if (attrName === MediaUIAttributes.MEDIA_DURATION || attrName === MediaUIAttributes.MEDIA_SEEKABLE) {
      this.renderFaceMarkers();
    }
  }

  /** Sampled instants currently marked on the track. */
  get faceMarkers(): number[] {
    return parseFaceSampleMarkers(this.getAttribute(FACE_MARKERS_ATTRIBUTE));
  }

  private renderFaceMarkers() {
    const container = this.shadowRoot?.querySelector('#container');
    if (!container) {
      return;
    }

    const existing = this.shadowRoot?.querySelector<HTMLElement>(`#${MARKER_LAYER_ID}`);
    const timestamps = this.faceMarkers;
    if (timestamps.length === 0) {
      existing?.remove();
      return;
    }

    const layer = existing ?? this.createMarkerLayer(container);
    const label = this.getAttribute(FACE_MARKERS_LABEL_ATTRIBUTE);
    if (label) {
      layer.setAttribute('role', 'img');
      layer.setAttribute('aria-label', label);
    }
    const markers = getFaceMarkerPositions(timestamps, (this.mediaDuration ?? 0) * 1000);
    layer.replaceChildren(
      ...markers.map(({ timestampMs, percent }) => {
        const marker = document.createElement('span');
        marker.dataset.faceMarker = String(timestampMs);
        marker.style.cssText = [
          'position:absolute',
          `inset-inline-start:${percent}%`,
          'top:50%',
          'width:3px',
          'height:8px',
          'transform:translate(-50%,-50%)',
          'border-radius:1px',
          'background:var(--face-marker-color,#facc15)',
          'pointer-events:none',
        ].join(';');
        return marker;
      }),
    );
    // Keep marks centred on the track regardless of the configured track height.
    const trackHeight = Number(getComputedStyle(this).getPropertyValue('--media-range-track-height'));
    layer.style.height = `${Number.isFinite(trackHeight) ? Math.max(trackHeight, 3) : 3.5}px`;
  }

  private createMarkerLayer(container: Element): HTMLElement {
    const layer = document.createElement('div');
    layer.id = MARKER_LAYER_ID;
    layer.setAttribute('part', MARKER_LAYER_ID);
    layer.style.cssText = [
      'position:absolute',
      'inset-inline:0',
      'top:50%',
      'height:0',
      // Above the track, but never above the input: seeking must keep working.
      'pointer-events:none',
      'z-index:1',
    ].join(';');
    container.append(layer);
    return layer;
  }

  private hold(event: Event) {
    if (event instanceof KeyboardEvent) {
      if (!this.keysUsed.includes(event.key)) {
        return;
      }
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(this.release, COMMIT_DELAY_MS);
    }
    this.seeking = true;
  }

  private intercept(event: Event) {
    if (!this.seeking) {
      return; // not mid-scrub, or this is the request we replay in release()
    }
    this.pending = (event as CustomEvent<number>).detail;
    event.stopImmediatePropagation();
  }

  private release() {
    clearTimeout(this.idleTimer);
    this.seeking = false;
    if (this.pending !== undefined) {
      const detail = this.pending;
      this.pending = undefined;
      this.dispatchEvent(new CustomEvent(MediaUIEvents.MEDIA_SEEK_REQUEST, { bubbles: true, composed: true, detail }));
    }
  }
}

if (!customElements.get('immich-time-range')) {
  customElements.define('immich-time-range', ImmichTimeRange);
}
