import { defineHandler } from '@timesheet/integration-sdk';
import { BasecampConfig } from '../lib/types';
import { createBasecampClient } from '../lib/taskSync';

const SYSTEM = 'basecamp';

export const testConnection = defineHandler<void, { system: string; ok: boolean; installationId: string }, BasecampConfig>(
  async (_input, context) => {
    context.logger.info('Testing Basecamp connection', {
      system: SYSTEM,
      installationId: context.installationId
    });

    const client = createBasecampClient(context);
    const ok = await client.testConnection();

    return {
      system: SYSTEM,
      ok,
      installationId: context.installationId
    };
  }
);
