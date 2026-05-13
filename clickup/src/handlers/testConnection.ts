import { defineHandler } from '@timesheet/integration-sdk';
import { ClickUpConfig } from '../lib/types';
import { createClickUpClient } from '../lib/taskSync';

const SYSTEM = 'clickup';

export const testConnection = defineHandler<void, { system: string; ok: boolean; installationId: string }, ClickUpConfig>(
  async (_input, context) => {
    const client = createClickUpClient(context);
    const ok = await client.testConnection();

    return {
      system: SYSTEM,
      ok,
      installationId: context.installationId
    };
  }
);
