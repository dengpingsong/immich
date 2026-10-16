<script lang="ts">
  import type { AssetFaceResponseDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';
  import { SvelteMap } from 'svelte/reactivity';
  import { assetCacheManager } from '$lib/managers/AssetCacheManager.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { Route } from '$lib/route';
  import { getContainedVideoSize, getFaceSampleAt } from '$lib/utils/video-face';

  let { assetId, sourceAssetId, player }: { assetId: string; sourceAssetId: string; player: HTMLVideoElement } =
    $props();
  let faces = $state<AssetFaceResponseDto[]>([]);
  // Hover wins while the pointer is on a box, and the last clicked box stays selected afterwards - the
  // same behaviour as the portraits in the detail panel. A second click follows the link to the person.
  let hoveredFaceId = $state<string>();
  let selectedFaceId = $state<string>();
  let keyboardNavigation = $state(false);
  const onWindowKeyDown = () => (keyboardNavigation = true);
  const onWindowPointerDown = () => (keyboardNavigation = false);
  let width = $state(0);
  let height = $state(0);
  let videoWidth = $state(0);
  let videoHeight = $state(0);
  let currentTime = $state(0);
  let seeking = $state(false);
  const size = $derived(getContainedVideoSize(width, height, videoWidth, videoHeight));
  const temporalFaces = $derived(
    faces.filter((face) => face.sourceAssetId === sourceAssetId && face.appearances?.length),
  );
  const identity = (face: AssetFaceResponseDto) => face.person?.id ?? face.id;
  // The detail-panel portrait publishes its faces; match only this video's faces so stale selections and
  // still-only faces cannot leak across assets.
  const portraitFace = $derived(
    temporalFaces.find((face) => assetViewerManager.highlightedFaces.some((selected) => selected.id === face.id)),
  );
  const activeHighlight = $derived(portraitFace ? identity(portraitFace) : (hoveredFaceId ?? selectedFaceId));
  const showOverlay = $derived(!!portraitFace || !!hoveredFaceId || !!selectedFaceId);
  const people = $derived.by(() => {
    const groups = new SvelteMap<
      string,
      { id: string; person: AssetFaceResponseDto['person']; timestamps: number[] }
    >();
    for (const face of temporalFaces) {
      const id = identity(face);
      const group = groups.get(id) ?? { id, person: face.person, timestamps: [] };
      group.timestamps.push(...(face.appearances ?? []).map((sample) => sample.timestampMs));
      groups.set(id, group);
    }
    return [...groups.values()].map((group) => ({
      ...group,
      timestamps: [...new Set(group.timestamps)].sort((a, b) => a - b),
    }));
  });
  const activeGroup = $derived(people.find((group) => group.id === activeHighlight));

  $effect(() => {
    // Marks are drawn on the native seek range. Hovering a box publishes a transient set of marks and the
    // selection publishes a sticky one, so clearing the hover (pointer leave) cannot wipe the selection.
    const markers = showOverlay ? (activeGroup?.timestamps ?? []) : [];
    if (markers.length === 0) {
      assetViewerManager.clearSelectedFaceSampleMarkers();
    } else if (hoveredFaceId) {
      assetViewerManager.setFaceSampleMarkers(markers);
    } else {
      assetViewerManager.selectFaceSampleMarkers(markers);
    }
  });

  $effect(() => {
    return () => assetViewerManager.clearFaceSampleMarkers();
  });

  $effect(() => {
    let cancelled = false;
    faces = [];
    hoveredFaceId = undefined;
    selectedFaceId = undefined;
    void assetCacheManager
      .getAssetFaces(assetId)
      .then((data) => {
        if (!cancelled) {
          faces = data;
        }
      })
      .catch(() => {
        /* Face metadata is optional; never interrupt playback on permission/network failures. */
      });
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    const video = player;
    const sync = () => {
      currentTime = video.currentTime;
      seeking = video.seeking;
      videoWidth = video.videoWidth;
      videoHeight = video.videoHeight;
    };
    const events = ['timeupdate', 'seeking', 'seeked', 'pause', 'play', 'loadedmetadata', 'durationchange', 'resize'];
    sync();
    for (const event of events) {
      video.addEventListener(event, sync);
    }
    return () => {
      for (const event of events) {
        video.removeEventListener(event, sync);
      }
    };
  });
</script>

<!--
  Only the bounding boxes of the currently highlighted person are drawn over the video. The navigable
  timestamp list stays in the detail panel and the sample positions are marked on the native seek range:
  an overlay that listed every sampled time inside the picture covered the frame, and on a tablet the
  hover it relied on could never be cancelled.
-->
<svelte:window onkeydown={onWindowKeyDown} onpointerdown={onWindowPointerDown} />

<div class="pointer-events-none absolute inset-0" bind:clientWidth={width} bind:clientHeight={height}>
  {#if showOverlay && !seeking && size.width > 0}
    <div
      class="pointer-events-none absolute top-1/2 left-1/2 -translate-1/2"
      style:width={`${size.width}px`}
      style:height={`${size.height}px`}
    >
      {#each temporalFaces as face (face.id)}
        {@const sample = getFaceSampleAt(face.appearances ?? [], currentTime)}
        {#if sample && sample.imageWidth > 0 && sample.imageHeight > 0}
          <div
            class={`absolute border-2 ${activeHighlight === identity(face) ? 'border-yellow-400' : 'border-white/50'}`}
            style:left={`${(100 * sample.boundingBoxX1) / sample.imageWidth}%`}
            style:top={`${(100 * sample.boundingBoxY1) / sample.imageHeight}%`}
            style:width={`${(100 * (sample.boundingBoxX2 - sample.boundingBoxX1)) / sample.imageWidth}%`}
            style:height={`${(100 * (sample.boundingBoxY2 - sample.boundingBoxY1)) / sample.imageHeight}%`}
          >
            {#if face.person}
              <a
                href={Route.viewPerson(face.person)}
                aria-label={face.person.name || $t('people')}
                data-face-box
                data-selected={selectedFaceId === face.id ? 'true' : undefined}
                class="pointer-events-auto absolute inset-0 focus-visible:outline"
                onpointerenter={(event) => {
                  // Touch never fires pointerleave, so a tap must not leave a hover highlight behind.
                  if (event.pointerType === 'mouse') {
                    hoveredFaceId = face.id;
                  }
                }}
                onpointerleave={() => {
                  if (hoveredFaceId === face.id) {
                    hoveredFaceId = undefined;
                  }
                }}
                onfocus={() => {
                  if (keyboardNavigation) {
                    selectedFaceId = face.id;
                  }
                }}
                onblur={() => (hoveredFaceId = undefined)}
                onclick={(event) => {
                  if (selectedFaceId === face.id) {
                    return;
                  }
                  event.preventDefault();
                  selectedFaceId = face.id;
                }}
              >
                {#if face.person.name}<span class="absolute bottom-full bg-black/70 px-1 text-xs text-white"
                    >{face.person.name}</span
                  >{/if}
              </a>
            {/if}
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>
