import { defineHandler } from '@timesheet/integration-sdk';
import { FreshBooksConfig, SyncInput } from '../lib/types';
import { FreshBooksSyncResult, syncTaskFromFreshBooks } from '../lib/taskSync';

export const syncTaskFromExternal = defineHandler<SyncInput, FreshBooksSyncResult, FreshBooksConfig>(
  async (input, context) => {
    context.logger.info('Syncing task from FreshBooks payload', {
      installationId: context.installationId,
      externalTaskId: input?.externalTaskId
    });

    return await syncTaskFromFreshBooks(input, context);
  }
);
