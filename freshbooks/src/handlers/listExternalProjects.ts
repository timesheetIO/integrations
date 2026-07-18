import { defineHandler, ExternalEntity } from '@timesheet/integration-sdk';
import { FreshBooksConfig } from '../lib/types';
import { createFreshBooksClient } from '../lib/taskSync';

const SYSTEM = 'freshbooks';

export const listExternalProjects = defineHandler<void, ExternalEntity[], FreshBooksConfig>(
  async (_input, context) => {
    context.logger.info('Listing FreshBooks projects', {
      system: SYSTEM,
      installationId: context.installationId
    });

    const client = createFreshBooksClient(context);
    return await client.listProjects();
  }
);
