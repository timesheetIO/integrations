import { defineHandler } from '@timesheet/integration-sdk';
import { AsanaConfig, SyncInput } from '../lib/types';
import { AsanaSyncResult, handleAsanaWebhook } from '../lib/taskSync';

export const handleWebhook = defineHandler<SyncInput, AsanaSyncResult, AsanaConfig>(
  async (input, context) => {
    context.logger.info('Handling Asana webhook', {
      installationId: context.installationId,
      hasBody: !!input?.body
    });

    return await handleAsanaWebhook(input, context);
  }
);
