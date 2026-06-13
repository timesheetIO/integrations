import { defineHandler } from '@timesheet/integration-sdk';
import { GoogleCalendarConfig } from '../lib/types';
import { GoogleCalendarSyncResult, runGoogleCalendarFullSync, ensureWatchChannels } from '../lib/taskSync';

interface ManualSyncInput {
  fullResync?: boolean;
  /** Legacy option from the updatedMin-window era — sync is now always token-based. */
  recentDays?: number;
}

export const runFullSync = defineHandler<ManualSyncInput | void, GoogleCalendarSyncResult, GoogleCalendarConfig>(
  async (input, context) => {
    const syncDirection = context.config?.syncDirection ?? 'bidirectional';
    const fullResync = !!input?.fullResync;

    context.logger.info('Running Google Calendar manual sync', {
      installationId: context.installationId,
      syncDirection,
      hasWebhookUrl: !!context.metadata?.webhooks?.['integration-webhook'],
      syncMode: fullResync ? 'full' : 'incremental'
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
        details: {
          watchChannelsRegistered: true,
          syncDirection,
          syncMode: fullResync ? 'full' : 'incremental'
        }
      };
    }

    if (fullResync) {
      // Force the token-restoring full listing instead of an incremental pass.
      context.logger.info('Full resync requested — clearing stored sync tokens');
    }

    // Always lock: a manual sync racing a webhook sync without the calendar
    // and import locks is exactly how duplicate tasks were created.
    const result = await runGoogleCalendarFullSync(context, {
      lockTtlSeconds: 15 * 60,
      forceFullResync: fullResync
    });
    return {
      ...result,
      details: {
        ...result.details,
        watchChannelsRegistered: true,
        syncMode: fullResync ? 'full' : 'incremental'
      }
    };
  }
);
