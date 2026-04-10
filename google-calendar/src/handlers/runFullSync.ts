import { defineHandler } from '@timesheet/integration-sdk';
import { GoogleCalendarConfig } from '../lib/types';
import { GoogleCalendarSyncResult, runGoogleCalendarFullSync, ensureWatchChannels } from '../lib/taskSync';

export const runFullSync = defineHandler<void, GoogleCalendarSyncResult, GoogleCalendarConfig>(
  async (_input, context) => {
    context.logger.info('Running Google Calendar full sync', {
      installationId: context.installationId,
      syncDirection: context.config?.syncDirection ?? 'bidirectional'
    });

    // Register watch channels first — this is fast (1-2 API calls per calendar)
    // and ensures inbound push notifications work even if the full sync times out.
    await ensureWatchChannels(context);

    const result = await runGoogleCalendarFullSync(context);
    return result;
  }
);
