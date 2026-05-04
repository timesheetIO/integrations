import { defineHandler } from '@timesheet/integration-sdk';
import { QuickBooksConfig, SyncInput } from '../lib/types';
import { QuickBooksSyncResult, syncTaskFromQuickBooks } from '../lib/taskSync';

export const syncTaskFromExternal = defineHandler<SyncInput, QuickBooksSyncResult, QuickBooksConfig>(
  async (input, context) => {
    context.logger.info('Syncing task from QuickBooks payload', {
      installationId: context.installationId,
      externalTaskId: input?.externalTaskId
    });

    return await syncTaskFromQuickBooks(input, context);
  }
);
