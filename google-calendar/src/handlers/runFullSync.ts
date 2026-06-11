import { defineHandler } from '@timesheet/integration-sdk';
import { GoogleCalendarConfig } from '../lib/types';
import { GoogleCalendarSyncResult, runGoogleCalendarFullSync, ensureWatchChannels } from '../lib/taskSync';

interface ManualSyncInput {
  fullResync?: boolean;
  recentDays?: number;
}

export const runFullSync = defineHandler<ManualSyncInput | void, GoogleCalendarSyncResult, GoogleCalendarConfig>(
  async (input, context) => {
    const syncDirection = context.config?.syncDirection ?? 'bidirectional';
    const fullResync = !!input?.fullResync;
    const recentDays = Number.isFinite(input?.recentDays) && input?.recentDays && input.recentDays > 0
      ? Math.min(Math.floor(input.recentDays), 30)
      : 7;
    const fallbackUpdatedMin = fullResync
      ? undefined
      : new Date(Date.now() - (recentDays * 24 * 60 * 60 * 1000)).toISOString();

    context.logger.info('Running Google Calendar manual sync', {
      installationId: context.installationId,
      syncDirection,
      hasWebhookUrl: !!context.metadata?.webhooks?.['integration-webhook'],
      syncMode: fullResync ? 'full' : 'recent',
      recentDays: fullResync ? undefined : recentDays
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
          syncMode: fullResync ? 'full' : 'recent'
        }
      };
    }

    const result = await runGoogleCalendarFullSync(context, {
      fallbackUpdatedMin,
      lockTtlSeconds: fullResync ? undefined : 15 * 60
    });
    return {
      ...result,
      details: {
        ...result.details,
        watchChannelsRegistered: true,
        syncMode: fullResync ? 'full' : 'recent',
        recentDays: fullResync ? undefined : recentDays
      }
    };
  }
);
