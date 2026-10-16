<script lang="ts">
  import ImageThumbnail from '$lib/components/assets/thumbnail/ImageThumbnail.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { faceManager } from '$lib/stores/face.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getPeopleThumbnailUrl } from '$lib/utils';
  import { formatFaceSampleTime, getFaceSampleTimes } from '$lib/utils/video-face';
  import { type AssetResponseDto } from '@immich/sdk';
  import { IconButton, Text } from '@immich/ui';
  import { mdiEye, mdiEyeOff, mdiPencil, mdiPlus } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  type Props = {
    asset: AssetResponseDto;
    isOwner: boolean;
    previousRoute: string;
  };

  const { asset, isOwner, previousRoute }: Props = $props();

  const people = $derived(Array.from(faceManager.people));

  const visiblePeople = $derived(
    people
      .filter((p) => assetViewerManager.isShowingHiddenPeople || !p.isHidden)
      .map((person) => {
        if (!person.birthDate) {
          return { formattedBirthDate: undefined, formattedAge: undefined, ...person };
        }
        const personBirthDate = DateTime.fromISO(person.birthDate);
        const ageInYears = Math.floor(DateTime.fromISO(asset.localDateTime).diff(personBirthDate, 'years').years);
        const ageInMonths = Math.floor(DateTime.fromISO(asset.localDateTime).diff(personBirthDate, 'months').months);

        let formattedAge;
        if (ageInYears < 0) {
          return { formattedBirthDate: undefined, formattedAge: undefined, ...person };
        }
        if (ageInMonths < 12) {
          formattedAge = $t('age_months', { values: { months: ageInMonths } });
        } else if (ageInMonths > 12 && ageInMonths < 24) {
          formattedAge = $t('age_year_months', { values: { months: ageInMonths - 12 } });
        } else {
          formattedAge = $t('age_years', { values: { years: ageInYears } });
        }

        const formattedBirthDate = personBirthDate.toLocaleString(
          {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
          },
          { locale: $locale },
        );
        return { formattedBirthDate, formattedAge, ...person };
      }),
  );

  const facesOf = (personId: string | undefined) => (personId ? (faceManager.facesByPersonId.get(personId) ?? []) : []);

  /**
   * Hover and click are separate states in the viewer manager: hovering is transient and wins while it
   * lasts, a selection sticks until something else is selected. Keeping them apart is what lets the photo
   * viewer clear its hover highlight on pointer leave without wiping the portrait the user just clicked.
   */
  const hoverPerson = (personId: string | undefined) => {
    const faces = facesOf(personId);
    assetViewerManager.setHighlightedFaces(faces);
    assetViewerManager.setFaceSampleMarkers(getFaceSampleTimes(faces));
  };

  const selectPerson = (personId: string | undefined) => {
    selectedPersonId = personId;
    const faces = facesOf(personId);
    assetViewerManager.selectFaces(faces);
    assetViewerManager.selectFaceSampleMarkers(getFaceSampleTimes(faces));
  };

  // A click selects a person the way hovering shows one, but the selection sticks. A second click on the
  // already selected person opens their gallery instead of navigating on the first click.
  let selectedPersonId = $state<string>();
  let keyboardNavigation = $state(false);

  const onPortraitClick = (event: MouseEvent, personId: string) => {
    if (selectedPersonId === personId) {
      // Second click: follow the link to the person's gallery.
      return;
    }
    event.preventDefault();
    selectPerson(personId);
  };

  $effect(() => {
    // Selections are per asset, so switching asset starts from a clean slate.
    void asset.id;
    selectPerson(undefined);
  });

  const onWindowKeyDown = () => (keyboardNavigation = true);
  const onWindowPointerDown = () => (keyboardNavigation = false);

  const onPortraitFocus = (personId: string) => {
    // Tabbing to a portrait selects it, so the next Enter follows the link. Focus caused by a mouse press
    // must not select it, otherwise the very first click would navigate again.
    if (keyboardNavigation) {
      selectPerson(personId);
    }
  };

  // Tablets never fire `pointerleave` after a tap, so a highlight started by touch had no way back and
  // the person (and their seek-range marks) stayed selected forever. Tapping anywhere outside the
  // portraits now clears it; hovering with a mouse still behaves as before.
  const onDocumentPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') {
      return;
    }
    const target = event.target as Element | null;
    if (target?.closest('[data-face-portrait]')) {
      return;
    }
    selectPerson(undefined);
  };

  // Hovering a portrait must always produce visible feedback, even when the asset is showing the still
  // photo and the person was only detected in the video: those boxes belong to another frame, so the
  // viewer cannot draw them here and used to look unresponsive.
  const hoveredPersonHint = $derived.by(() => {
    const person = visiblePeople.find((candidate) =>
      (faceManager.facesByPersonId.get(candidate.id) ?? []).some((face) =>
        assetViewerManager.highlightedFaces.some((selected) => selected.id === face.id),
      ),
    );
    if (!person) {
      return undefined;
    }
    const faces = faceManager.facesByPersonId.get(person.id) ?? [];
    const samples = getFaceSampleTimes(faces);
    if (samples.length === 0) {
      return $t('video_face_portrait_still_only');
    }
    return $t('video_face_portrait_video_samples', {
      values: { samples: samples.map((timestamp) => formatFaceSampleTime(timestamp)).join(' · ') },
    });
  });
</script>

<svelte:document onpointerdown={onDocumentPointerDown} />
<svelte:window onkeydown={onWindowKeyDown} onpointerdown={onWindowPointerDown} />

{#if !authManager.isSharedLink}
  <section class="px-4 pt-4 text-sm">
    {#if isOwner || visiblePeople.length > 0}
      <div class="flex h-10 w-full items-center justify-between">
        <Text size="small" color="muted">{$t('people')}</Text>
        <div class="flex items-center gap-2">
          {#if isOwner}
            {#if people.some((person) => person.isHidden)}
              <IconButton
                aria-label={$t('show_hidden_people')}
                icon={assetViewerManager.isShowingHiddenPeople ? mdiEyeOff : mdiEye}
                size="medium"
                shape="round"
                color="secondary"
                variant="ghost"
                onclick={() => assetViewerManager.toggleHiddenPeople()}
              />
            {/if}
            <IconButton
              aria-label={$t('tag_people')}
              icon={mdiPlus}
              size="medium"
              shape="round"
              color="secondary"
              variant="ghost"
              onclick={() => assetViewerManager.toggleFaceEditMode()}
            />

            {#if faceManager.data.length > 0}
              <IconButton
                aria-label={$t('edit_people')}
                icon={mdiPencil}
                size="medium"
                shape="round"
                color="secondary"
                variant="ghost"
                onclick={() => assetViewerManager.openEditFacesPanel()}
              />
            {/if}
          {/if}
        </div>
      </div>
    {/if}

    <div class="mt-2 grid {visiblePeople.length <= 6 ? 'grid-cols-3 gap-3' : 'grid-cols-4 gap-2'}">
      {#each visiblePeople as person (person.id)}
        {@const personFaces = faceManager.facesByPersonId.get(person.id) ?? []}
        {@const isHighlighted = personFaces.some((f) => assetViewerManager.highlightedFaces.some((b) => b.id === f.id))}
        <a
          class="group outline-none"
          href={Route.viewPerson(person, { previousRoute })}
          data-face-portrait
          data-selected={selectedPersonId === person.id ? 'true' : undefined}
          class:ring-2={selectedPersonId === person.id}
          onfocus={() => onPortraitFocus(person.id)}
          onblur={() => hoverPerson(undefined)}
          onpointerenter={(event) => {
            if (event.pointerType === 'mouse') {
              hoverPerson(person.id);
            }
          }}
          onpointerleave={() => hoverPerson(undefined)}
          onclick={(event) => onPortraitClick(event, person.id)}
        >
          <ImageThumbnail
            curve
            shadow
            url={getPeopleThumbnailUrl(person)}
            altText={person.name}
            title={person.name}
            widthStyle="100%"
            hidden={person.isHidden}
            highlighted={isHighlighted}
            class="outline-offset-2 outline-immich-primary group-focus-visible:outline-2 dark:outline-immich-dark-primary"
          />
          <p class="mt-1 truncate font-medium" title={person.name}>{person.name}</p>
          {#if person.birthDate && person.formattedAge}
            <p class="font-light {visiblePeople.length > 6 ? 'text-xs' : ''}" title={person.formattedBirthDate!}>
              {person.formattedAge}
            </p>
          {/if}
        </a>
      {/each}
    </div>
    {#if hoveredPersonHint}
      <p class="mt-2 text-xs text-gray-500 dark:text-gray-400" data-face-hover-hint>{hoveredPersonHint}</p>
    {/if}
  </section>
{/if}
