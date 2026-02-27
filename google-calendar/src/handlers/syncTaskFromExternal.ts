import { defineHandler } from '@timesheet/integration-sdk';
import { GoogleCalendarConfig, GoogleCalendarSyncInput } from '../lib/types';
import { GoogleCalendarSyncResult, handleGoogleWebhook } from '../lib/taskSync';

export const syncTaskFromExternal = defineHandler<GoogleCalendarSyncInput, GoogleCalendarSyncResult, GoogleCalendarConfig>(
  async (input, context) => {
    context.logger.info('Syncing task from Google Calendar payload', {
      installationId: context.installationId,
      externalTaskId: input?.externalTaskId
    });

    return await handleGoogleWebhook(input, context);
  }
);
