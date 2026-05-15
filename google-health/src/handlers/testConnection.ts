import { defineHandler } from '@timesheet/integration-sdk';
import { GoogleHealthConfig } from '../lib/types';
import { createGoogleHealthClient, PLUGIN_SYSTEM } from '../lib/exerciseSync';

export const testConnection = defineHandler<void, { system: string; ok: boolean; installationId: string }, GoogleHealthConfig>(
  async (_input, context) => {
    const client = createGoogleHealthClient(context);
    const ok = await client.testConnection();

    return {
      system: PLUGIN_SYSTEM,
      ok,
      installationId: context.installationId
    };
  }
);
