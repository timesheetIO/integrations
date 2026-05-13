import { defineHandler } from '@timesheet/integration-sdk';
import { MondayConfig } from '../lib/types';
import { MondaySyncResult, runMondayFullSync } from '../lib/taskSync';

export const runFullSync = defineHandler<void, MondaySyncResult, MondayConfig>(
  async (_input, context) => {
    context.logger.info('Running monday.com full sync', {
      installationId: context.installationId,
      syncDirection: context.config?.syncDirection ?? 'bidirectional'
    });

    return await runMondayFullSync(context);
  }
);
