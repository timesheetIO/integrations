import { defineHandler, ExternalEntity } from '@timesheet/integration-sdk';
import { QuickBooksConfig } from '../lib/types';
import { createQuickBooksClient } from '../lib/taskSync';

const SYSTEM = 'quickbooks';

export const listExternalProjects = defineHandler<void, ExternalEntity[], QuickBooksConfig>(
  async (_input, context) => {
    context.logger.info('Listing QuickBooks customers', {
      system: SYSTEM,
      installationId: context.installationId
    });

    const client = await createQuickBooksClient(context);
    return await client.listCustomers();
  }
);
