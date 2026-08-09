import { defineHandler } from '@timesheet/integration-sdk';
import { BasecampConfig, SyncInput } from '../lib/types';
import { BasecampSyncResult, handleBasecampWebhook } from '../lib/taskSync';

export const handleWebhook = defineHandler<SyncInput, BasecampSyncResult, BasecampConfig>(
  async (input, context) => {
    context.logger.info('Handling Basecamp webhook', {
      installationId: context.installationId,
      hasBody: !!input?.body
    });

    return await handleBasecampWebhook(input, context);
  }
);
