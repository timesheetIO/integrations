import { defineHandler } from '@timesheet/integration-sdk';
import { MondayConfig } from '../lib/types';
import { createMondayClient } from '../lib/taskSync';

const SYSTEM = 'monday';

export const testConnection = defineHandler<void, { system: string; ok: boolean; installationId: string }, MondayConfig>(
  async (_input, context) => {
    const client = createMondayClient(context);
    const ok = await client.testConnection();

    return {
      system: SYSTEM,
      ok,
      installationId: context.installationId
    };
  }
);
