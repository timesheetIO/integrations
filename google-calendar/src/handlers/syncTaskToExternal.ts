import { defineHandler } from '@timesheet/integration-sdk';
import { GoogleCalendarConfig, GoogleCalendarSyncInput } from '../lib/types';
import { GoogleCalendarSyncResult, syncTaskToGoogleCalendar } from '../lib/taskSync';

export const syncTaskToExternal = defineHandler<GoogleCalendarSyncInput, GoogleCalendarSyncResult, GoogleCalendarConfig>(
  async (input, context) => {
    context.logger.info('Syncing task to Google Calendar', {
      installationId: context.installationId,
      taskId: input?.taskId ?? input?.item?.id,
      event: input?.event
    });

    return await syncTaskToGoogleCalendar(input, context);
  }
);
