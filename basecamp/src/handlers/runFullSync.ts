import { defineHandler } from '@timesheet/integration-sdk';
import { BasecampConfig } from '../lib/types';
import { BasecampSyncResult, runBasecampFullSync } from '../lib/taskSync';

export const runFullSync = defineHandler<void, BasecampSyncResult, BasecampConfig>(
  async (_input, context) => {
    context.logger.info('Running Basecamp full sync', {
      installationId: context.installationId,
      syncDirection: context.config?.syncDirection ?? 'bidirectional'
    });

    return await runBasecampFullSync(context);
  }
);
