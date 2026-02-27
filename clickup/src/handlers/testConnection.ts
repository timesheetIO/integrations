import { defineHandler } from '@timesheet/integration-sdk';

const SYSTEM = 'clickup';

export const testConnection = defineHandler<void, { system: string; ok: boolean; installationId: string }>(
  async (_input, context) => {
    context.logger.info('Testing integration connection', {
      system: SYSTEM,
      installationId: context.installationId
    });

    return {
      system: SYSTEM,
      ok: true,
      installationId: context.installationId
    };
  }
);
