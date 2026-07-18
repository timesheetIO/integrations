import { defineHandler } from '@timesheet/integration-sdk';
import { NotionConfig } from '../lib/types';
import { NotionSyncResult, runNotionFullSync } from '../lib/taskSync';

export const runFullSync = defineHandler<void, NotionSyncResult, NotionConfig>(
  async (_input, context) => {
    context.logger.info('Running Notion full sync', {
      installationId: context.installationId,
      syncDirection: context.config?.syncDirection ?? 'bidirectional'
    });

    return await runNotionFullSync(context);
  }
);
