import { defineHandler } from '@timesheet/integration-sdk';
import { QuickBooksConfig } from '../lib/types';
import { QuickBooksSyncResult, runQuickBooksFullSync } from '../lib/taskSync';

export const runFullSync = defineHandler<void, QuickBooksSyncResult, QuickBooksConfig>(
  async (_input, context) => {
    context.logger.info('Running QuickBooks full sync', {
      installationId: context.installationId,
      syncDirection: context.config?.syncDirection ?? 'bidirectional'
    });

    return await runQuickBooksFullSync(context);
  }
);
