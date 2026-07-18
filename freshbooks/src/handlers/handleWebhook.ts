import { defineHandler } from '@timesheet/integration-sdk';
import { FreshBooksConfig, SyncInput } from '../lib/types';
import { FreshBooksSyncResult, handleFreshBooksWebhook } from '../lib/taskSync';

export const handleWebhook = defineHandler<SyncInput, FreshBooksSyncResult, FreshBooksConfig>(
  async (input, context) => {
    context.logger.info('Handling FreshBooks webhook', {
      installationId: context.installationId,
      hasBody: !!input?.body
    });

    return await handleFreshBooksWebhook(input, context);
  }
);
