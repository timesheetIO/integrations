import { defineHandler, ExternalEntity } from '@timesheet/integration-sdk';
import { MondayConfig } from '../lib/types';
import { createMondayClient } from '../lib/taskSync';

const SYSTEM = 'monday';

export const listExternalUsers = defineHandler<void, ExternalEntity[], MondayConfig>(
  async (_input, context) => {
    context.logger.info('Listing monday.com users', {
      system: SYSTEM,
      installationId: context.installationId
    });

    const client = createMondayClient(context);
    return await client.listUsersAsEntities();
  }
);
