import { defineHandler, WebhookInput } from '@timesheet/integration-sdk';

const SYSTEM = 'xero';

export const handleWebhook = defineHandler<WebhookInput, { system: string; handled: boolean }>(
  async (input, context) => {
    context.logger.info('Handling webhook', {
      system: SYSTEM,
      method: input.method,
      installationId: context.installationId
    });

    return {
      system: SYSTEM,
      handled: true
    };
  }
);
