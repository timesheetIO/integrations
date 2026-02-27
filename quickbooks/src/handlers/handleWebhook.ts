import { defineHandler } from '@timesheet/integration-sdk';
import { QuickBooksConfig, SyncInput } from '../lib/types';
import { QuickBooksSyncResult, handleQuickBooksWebhook } from '../lib/taskSync';

export const handleWebhook = defineHandler<SyncInput, QuickBooksSyncResult, QuickBooksConfig>(
  async (input, context) => {
    context.logger.info('Handling QuickBooks webhook', {
      installationId: context.installationId,
      hasBody: !!input?.body
    });

    return await handleQuickBooksWebhook(input, context);
  }
);
