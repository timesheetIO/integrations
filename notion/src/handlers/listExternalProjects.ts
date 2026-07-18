import { defineHandler, ExternalEntity } from '@timesheet/integration-sdk';
import { NotionConfig } from '../lib/types';
import { createNotionClient } from '../lib/taskSync';

const SYSTEM = 'notion';

export const listExternalProjects = defineHandler<void, ExternalEntity[], NotionConfig>(
  async (_input, context) => {
    context.logger.info('Listing Notion databases', {
      system: SYSTEM,
      installationId: context.installationId
    });

    const client = createNotionClient(context);
    return await client.searchDatabases();
  }
);
