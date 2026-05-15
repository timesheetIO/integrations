import { defineHandler } from '@timesheet/integration-sdk';
import { AsanaConfig } from '../lib/types';
import { AsanaSyncResult, runAsanaFullSync } from '../lib/taskSync';

export const runFullSync = defineHandler<void, AsanaSyncResult, AsanaConfig>(
  async (_input, context) => {
    context.logger.info('Running Asana full sync', {
      installationId: context.installationId,
      syncDirection: context.config?.syncDirection ?? 'bidirectional'
    });

    return await runAsanaFullSync(context);
  }
);
