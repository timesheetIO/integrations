import { defineHandler } from '@timesheet/integration-sdk';
import { ClickUpConfig, SyncInput } from '../lib/types';
import { ClickUpSyncResult, handleClickUpWebhook } from '../lib/taskSync';

export const handleWebhook = defineHandler<SyncInput, ClickUpSyncResult, ClickUpConfig>(
  async (input, context) => {
    context.logger.info('Handling ClickUp webhook', {
      installationId: context.installationId,
      hasBody: !!input?.body
    });

    return await handleClickUpWebhook(input, context);
  }
);
