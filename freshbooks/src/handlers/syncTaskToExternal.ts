import { defineHandler } from '@timesheet/integration-sdk';
import { FreshBooksConfig, SyncInput } from '../lib/types';
import { FreshBooksSyncResult, syncTaskToFreshBooks } from '../lib/taskSync';

export const syncTaskToExternal = defineHandler<SyncInput, FreshBooksSyncResult, FreshBooksConfig>(
  async (input, context) => {
    context.logger.info('Syncing task to FreshBooks', {
      installationId: context.installationId,
      event: input?.event,
      taskId: input?.taskId ?? input?.item?.id
    });

    return await syncTaskToFreshBooks(input, context);
  }
);
