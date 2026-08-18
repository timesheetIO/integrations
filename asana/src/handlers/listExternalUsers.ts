import { defineHandler, ExternalEntity } from '@timesheet/integration-sdk';
import { AsanaConfig } from '../lib/types';
import { createAsanaClient } from '../lib/taskSync';

const SYSTEM = 'asana';

export const listExternalUsers = defineHandler<void, ExternalEntity[], AsanaConfig>(
  async (_input, context) => {
    context.logger.info('Listing Asana users', {
      system: SYSTEM,
      installationId: context.installationId
    });

    const client = createAsanaClient(context);
    return await client.listUsers();
  }
);
