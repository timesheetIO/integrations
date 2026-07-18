import { defineHandler } from '@timesheet/integration-sdk';
import { FreshBooksConfig } from '../lib/types';
import { FreshBooksSyncResult, registerFreshBooksWebhooks } from '../lib/taskSync';

export const registerWebhooks = defineHandler<void, FreshBooksSyncResult, FreshBooksConfig>(
  async (_input, context) => {
    context.logger.info('Registering FreshBooks webhooks', {
      installationId: context.installationId
    });

    return await registerFreshBooksWebhooks(context);
  }
);
