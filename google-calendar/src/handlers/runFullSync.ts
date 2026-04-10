import { defineHandler } from '@timesheet/integration-sdk';
import { GoogleCalendarConfig } from '../lib/types';
import { GoogleCalendarSyncResult, runGoogleCalendarFullSync, ensureWatchChannels } from '../lib/taskSync';

export const runFullSync = defineHandler<void, GoogleCalendarSyncResult, GoogleCalendarConfig>(
  async (_input, context) => {
    const syncDirection = context.config?.syncDirection ?? 'bidirectional';
    context.logger.info('Running Google Calendar manual sync', {
      installationId: context.installationId,
      syncDirection,
      hasWebhookUrl: !!context.metadata?.webhooks?.['integration-webhook']
    });

    // Register watch channels — this is the critical part for inbound sync.
    // Fast: 1-2 API calls per mapped calendar.
    await ensureWatchChannels(context);
    context.logger.info('Watch channel setup completed');

    // Only run inbound event sync if direction allows it.
    // This can be slow for large calendars — the watch channels above
    // ensure incremental updates flow via push even if this part times out.
    const allowInbound = syncDirection !== 'timesheet-to-google' && syncDirection !== 'timesheet-to-external';
    if (!allowInbound) {
      return {
        system: 'google-calendar',
        status: 'completed',
        syncedCount: 0,
        details: { watchChannelsRegistered: true, syncDirection }
      };
    }

    const result = await runGoogleCalendarFullSync(context);
    return {
      ...result,
      details: { ...result.details, watchChannelsRegistered: true }
    };
  }
);
