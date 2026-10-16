import { QueueCommand, QueueName, runQueueCommandLegacy } from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { mutationOptions } from '@tanstack/svelte-query';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';

export const scanAllLibrariesMutation = () =>
  mutationOptions({
    mutationFn: () =>
      runQueueCommandLegacy({ name: QueueName.Library, queueCommandDto: { command: QueueCommand.Start } }),
    onSuccess: async () => {
      const $t = await getFormatter();
      toastManager.info($t('admin.refreshing_all_libraries'));
    },
    onError: async (error) => {
      const $t = await getFormatter();
      handleError(error, $t('errors.unable_to_scan_libraries'));
    },
  });
