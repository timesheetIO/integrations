import { defineHandler } from '@timesheet/integration-sdk';
import { QuickBooksConfig } from '../lib/types';
import { createQuickBooksClient } from '../lib/taskSync';

const SYSTEM = 'quickbooks';

export const testConnection = defineHandler<void, { system: string; ok: boolean; installationId: string; realmId: string }, QuickBooksConfig>(
  async (_input, context) => {
    const connectionInfo = await context.credentials.getConnectionInfo(SYSTEM);
    const realmId = connectionInfo?.accountId;

    if (!realmId) {
      return {
        system: SYSTEM,
        ok: false,
        installationId: context.installationId,
        realmId: ''
      };
    }

    const client = await createQuickBooksClient(context, realmId);
    const ok = await client.testConnection();

    return {
      system: SYSTEM,
      ok,
      installationId: context.installationId,
      realmId
    };
  }
);
