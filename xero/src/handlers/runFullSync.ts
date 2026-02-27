import { defineHandler } from '@timesheet/integration-sdk';

const SYSTEM = 'xero';

export const runFullSync = defineHandler<void, { system: string; status: string; syncedCount: number }>(
  async (_input, context) => {
    context.logger.info('Running full sync', {
      system: SYSTEM,
      installationId: context.installationId,
      syncDirection: context.config?.syncDirection ?? 'bidirectional'
    });

    return {
      system: SYSTEM,
      status: 'completed',
      syncedCount: 0
    };
  }
);
