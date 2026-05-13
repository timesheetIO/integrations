import { defineHandler } from '@timesheet/integration-sdk';
import { ClickUpConfig } from '../lib/types';
import { ClickUpSyncResult, runClickUpFullSync } from '../lib/taskSync';

export const runFullSync = defineHandler<void, ClickUpSyncResult, ClickUpConfig>(
  async (_input, context) => {
    context.logger.info('Running ClickUp full sync', {
      installationId: context.installationId,
      syncDirection: context.config?.syncDirection ?? 'bidirectional'
    });

    return await runClickUpFullSync(context);
  }
);
