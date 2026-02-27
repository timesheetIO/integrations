import { defineHandler, WebhookInput } from '@timesheet/integration-sdk';

const SYSTEM = 'asana';

export const syncTaskFromExternal = defineHandler<WebhookInput, { system: string; accepted: boolean }>(
  async (input, context) => {
    context.logger.info('Syncing task from external payload', {
      system: SYSTEM,
      method: input.method,
      installationId: context.installationId
    });

    return {
      system: SYSTEM,
      accepted: true
    };
  }
);
