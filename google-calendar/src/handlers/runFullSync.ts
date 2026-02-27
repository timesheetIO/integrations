import { defineHandler } from '@timesheet/integration-sdk';
import { GoogleCalendarConfig } from '../lib/types';
import { GoogleCalendarSyncResult, runGoogleCalendarFullSync } from '../lib/taskSync';

export const runFullSync = defineHandler<void, GoogleCalendarSyncResult, GoogleCalendarConfig>(
  async (_input, context) => {
    context.logger.info('Running Google Calendar full sync', {
      installationId: context.installationId,
      syncDirection: context.config?.syncDirection ?? 'bidirectional'
    });

    return await runGoogleCalendarFullSync(context);
  }
);
