import { defineHandler, IntegrationContext } from '@timesheet/integration-sdk';
import { QuickBooksConfig } from '../lib/types';
import { QuickBooksClient } from '../lib/quickbooksClient';

const SYSTEM = 'quickbooks';

async function createClient(context: IntegrationContext<QuickBooksConfig>): Promise<QuickBooksClient> {
  const connectionInfo = await context.credentials.getConnectionInfo(SYSTEM);
  const realmId = connectionInfo?.accountId;

  if (!realmId) {
    throw new Error('QuickBooks realmId/accountId missing. Complete OAuth first.');
  }

  return new QuickBooksClient({
    realmId,
    sandboxMode: context.config?.sandboxMode === true,
    getAccessToken: () => context.credentials.getAccessToken(SYSTEM),
    refreshAccessToken: () => context.credentials.refreshToken(SYSTEM)
  });
}

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

    const client = await createClient(context);
    const ok = await client.testConnection();

    return {
      system: SYSTEM,
      ok,
      installationId: context.installationId,
      realmId
    };
  }
);
