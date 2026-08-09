import { defineHandler } from '@timesheet/integration-sdk';
import { BasecampConfig } from '../lib/types';
import { BasecampSyncResult, registerBasecampWebhooks } from '../lib/taskSync';

export const registerWebhooks = defineHandler<void, BasecampSyncResult, BasecampConfig>(
  async (_input, context) => {
    context.logger.info('Registering Basecamp webhooks', {
      installationId: context.installationId,
      hasWebhookUrl: !!context.metadata?.webhooks?.['integration-webhook']
    });

    return await registerBasecampWebhooks(context);
  }
);
