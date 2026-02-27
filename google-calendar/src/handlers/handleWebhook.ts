import { defineHandler } from '@timesheet/integration-sdk';
import { GoogleCalendarConfig, GoogleCalendarSyncInput } from '../lib/types';
import { GoogleCalendarSyncResult, handleGoogleWebhook } from '../lib/taskSync';

export const handleWebhook = defineHandler<GoogleCalendarSyncInput, GoogleCalendarSyncResult, GoogleCalendarConfig>(
  async (input, context) => {
    context.logger.info('Handling Google Calendar webhook', {
      installationId: context.installationId
    });

    return await handleGoogleWebhook(input, context);
  }
);
