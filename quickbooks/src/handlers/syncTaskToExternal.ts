import { defineHandler } from '@timesheet/integration-sdk';
import { QuickBooksConfig, SyncInput } from '../lib/types';
import { QuickBooksSyncResult, syncTaskToQuickBooks } from '../lib/taskSync';

export const syncTaskToExternal = defineHandler<SyncInput, QuickBooksSyncResult, QuickBooksConfig>(
  async (input, context) => {
    context.logger.info('Syncing task to QuickBooks', {
      installationId: context.installationId,
      event: input?.event,
      taskId: input?.taskId ?? input?.item?.id
    });

    return await syncTaskToQuickBooks(input, context);
  }
);
