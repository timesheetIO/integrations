import { defineHandler, ExternalEntity } from '@timesheet/integration-sdk';
import { AsanaConfig } from '../lib/types';
import { createAsanaClient } from '../lib/taskSync';

const SYSTEM = 'asana';

export const listExternalProjects = defineHandler<void, ExternalEntity[], AsanaConfig>(
  async (_input, context) => {
    context.logger.info('Listing Asana projects', {
      system: SYSTEM,
      installationId: context.installationId
    });

    const client = createAsanaClient(context);
    return await client.listProjects();
  }
);
