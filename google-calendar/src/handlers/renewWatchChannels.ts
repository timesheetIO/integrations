import { defineHandler } from '@timesheet/integration-sdk';
import { GoogleCalendarConfig } from '../lib/types';
import { GoogleCalendarSyncResult, ensureWatchChannels } from '../lib/taskSync';

const SYSTEM = 'google-calendar';

/**
 * Keeps the Google push channels alive on their own schedule.
 *
 * Renewal used to happen only inside handleSyncBatch, which the backend skips
 * whenever a run has no task changes for a mapped project. Installs whose
 * mapped project sees no local activity therefore never renewed, the 7-day
 * watch TTL ran out, and inbound sync stopped without logging anything.
 *
 * The trigger carries no `mode: "sync"`, so the dispatcher queues it
 * unconditionally instead of routing it through the change-set gate.
 */
export const renewWatchChannels = defineHandler<void, GoogleCalendarSyncResult, GoogleCalendarConfig>(
  async (_input, context) => {
    context.logger.info('Renewing Google Calendar watch channels', {
      installationId: context.installationId,
      hasWebhookUrl: !!context.metadata?.webhooks?.['integration-webhook']
    });

    await ensureWatchChannels(context);

    return {
      system: SYSTEM,
      status: 'completed',
      syncedCount: 0,
      details: { watchChannelsChecked: true }
    };
  }
);
