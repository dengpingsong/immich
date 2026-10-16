<script lang="ts">
  import { goto } from '$app/navigation';
  import { createDefinedQuery, executeMutation } from '$lib/queries/client';
  import { getLibraryQuery, renameLibraryMutation } from '$lib/queries/library.query';
  import { Route } from '$lib/route';
  import { Field, FormModal, Input } from '@immich/ui';
  import { mdiRenameOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { PageProps } from './$types';

  const { params }: PageProps = $props();

  const query = createDefinedQuery(getLibraryQuery(params.id));
  const library = $derived(query.data);
  let name = $derived(library.name);

  const onClose = async () => {
    await goto(Route.viewLibrary(library));
  };

  const onSubmit = async () => {
    const response = await executeMutation(renameLibraryMutation(), { id: library.id, name });
    if (response) {
      await onClose();
    }
  };
</script>

<FormModal icon={mdiRenameOutline} title={$t('edit')} {onSubmit} {onClose} size="small">
  <Field label={$t('name')}>
    <Input bind:value={name} />
  </Field>
</FormModal>
