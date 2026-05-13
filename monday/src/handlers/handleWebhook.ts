import { defineHandler } from '@timesheet/integration-sdk';
import { MondayConfig, SyncInput } from '../lib/types';
import { MondaySyncResult, handleMondayWebhook } from '../lib/taskSync';

export const handleWebhook = defineHandler<SyncInput, MondaySyncResult, MondayConfig>(
  async (input, context) => {
    context.logger.info('Handling monday.com webhook', {
      installationId: context.installationId,
      hasBody: !!input?.body
    });

    return await handleMondayWebhook(input, context);
  }
);
