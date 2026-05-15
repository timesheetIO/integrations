import { defineHandler } from '@timesheet/integration-sdk';
import { AsanaConfig } from '../lib/types';
import { createAsanaClient } from '../lib/taskSync';

const SYSTEM = 'asana';

export const testConnection = defineHandler<void, { system: string; ok: boolean; installationId: string }, AsanaConfig>(
  async (_input, context) => {
    context.logger.info('Testing Asana connection', {
      system: SYSTEM,
      installationId: context.installationId
    });

    const client = createAsanaClient(context);
    const ok = await client.testConnection();

    return {
      system: SYSTEM,
      ok,
      installationId: context.installationId
    };
  }
);
