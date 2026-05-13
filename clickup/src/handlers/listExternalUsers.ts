import { defineHandler, ExternalEntity } from '@timesheet/integration-sdk';
import { ClickUpConfig } from '../lib/types';
import { createClickUpClient } from '../lib/taskSync';

const SYSTEM = 'clickup';

export const listExternalUsers = defineHandler<void, ExternalEntity[], ClickUpConfig>(
  async (_input, context) => {
    context.logger.info('Listing ClickUp workspace members', {
      system: SYSTEM,
      installationId: context.installationId
    });

    const client = createClickUpClient(context);
    return await client.listAllMembers();
  }
);
