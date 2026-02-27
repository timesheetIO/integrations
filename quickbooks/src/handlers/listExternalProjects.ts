import { defineHandler, ExternalEntity, IntegrationContext } from '@timesheet/integration-sdk';
import { QuickBooksConfig } from '../lib/types';
import { QuickBooksClient } from '../lib/quickbooksClient';

const SYSTEM = 'quickbooks';

async function createClient(context: IntegrationContext<QuickBooksConfig>): Promise<QuickBooksClient> {
  const connectionInfo = await context.credentials.getConnectionInfo(SYSTEM);
  const realmId = connectionInfo?.accountId || context.config?.realmId;

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

export const listExternalProjects = defineHandler<void, ExternalEntity[], QuickBooksConfig>(
  async (_input, context) => {
    context.logger.info('Listing QuickBooks customers', {
      system: SYSTEM,
      installationId: context.installationId
    });

    const client = await createClient(context);
    return await client.listCustomers();
  }
);
