import { defineHandler } from '@timesheet/integration-sdk';

const SYSTEM = 'outlook-calendar';

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
