import { defineHandler, ExternalEntity } from '@timesheet/integration-sdk';
import { BasecampConfig } from '../lib/types';
import { createBasecampClient } from '../lib/taskSync';

const SYSTEM = 'basecamp';

export const listExternalProjects = defineHandler<void, ExternalEntity[], BasecampConfig>(
  async (_input, context) => {
    context.logger.info('Listing Basecamp projects', {
      system: SYSTEM,
      installationId: context.installationId
    });

    const client = createBasecampClient(context);
    return await client.listProjects();
  }
);
