import { defineHandler } from '@timesheet/integration-sdk';
import { FreshBooksConfig } from '../lib/types';
import { FreshBooksSyncResult, runFreshBooksFullSync } from '../lib/taskSync';

export const runFullSync = defineHandler<void, FreshBooksSyncResult, FreshBooksConfig>(
  async (_input, context) => {
    context.logger.info('Running FreshBooks full sync', {
      installationId: context.installationId,
      syncDirection: context.config?.syncDirection ?? 'bidirectional'
    });

    return await runFreshBooksFullSync(context);
  }
);
