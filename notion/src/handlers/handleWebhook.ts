import { defineHandler } from '@timesheet/integration-sdk';
import { NotionConfig, SyncInput } from '../lib/types';
import { NotionSyncResult, handleNotionWebhook } from '../lib/taskSync';

export const handleWebhook = defineHandler<SyncInput, NotionSyncResult, NotionConfig>(
  async (input, context) => {
    context.logger.info('Handling Notion webhook', {
      installationId: context.installationId,
      hasBody: !!input?.body
    });

    return await handleNotionWebhook(input, context);
  }
);
