import { defineHandler } from '@timesheet/integration-sdk';
import { GoogleCalendarConfig } from '../lib/types';
import { GoogleCalendarSyncResult, runGoogleCalendarFullSync, ensureWatchChannels } from '../lib/taskSync';

export const runFullSync = defineHandler<void, GoogleCalendarSyncResult, GoogleCalendarConfig>(
  async (_input, context) => {
    context.logger.info('Running Google Calendar full sync', {
      installationId: context.installationId,
      syncDirection: context.config?.syncDirection ?? 'bidirectional'
    });

    const result = await runGoogleCalendarFullSync(context);

    // Ensure watch channels are active for inbound push notifications
    await ensureWatchChannels(context);

    return result;
  }
);
