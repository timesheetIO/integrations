import { defineHandler } from '@timesheet/integration-sdk';
import { OutlookCalendarConfig } from '../lib/types';
import { OutlookCalendarSyncResult, allowsInbound, ensureSubscription, runInboundSync } from '../lib/taskSync';

const SYSTEM = 'outlook-calendar';

interface ManualSyncInput {
  /** Ignore the stored change feeds and list every mapped calendar again. */
  fullResync?: boolean;
}

export const runFullSync = defineHandler<ManualSyncInput | void, OutlookCalendarSyncResult, OutlookCalendarConfig>(
  async (input, context) => {
    const syncDirection = context.config?.syncDirection ?? 'bidirectional';
    const fullResync = !!input?.fullResync;

    context.logger.info('Running Outlook Calendar manual sync', {
      installationId: context.installationId,
      syncDirection,
      hasWebhookUrl: !!context.metadata?.webhooks?.['integration-webhook'],
      syncMode: fullResync ? 'full' : 'incremental'
    });

    if (!allowsInbound(context)) {
      return { system: SYSTEM, status: 'completed', syncedCount: 0, details: { syncDirection } };
    }

    const result = await runInboundSync(context, { forceFullResync: fullResync });
    if (result.status === 'skipped') {
      return { ...result, status: 'completed' };
    }

    // Change notifications are what bring later Outlook edits in.
    let subscription: string;
    try {
      subscription = await ensureSubscription(context);
    } catch (err) {
      context.logger.error('Failed to set up the Outlook subscription', { error: String(err) });
      subscription = 'failed';
    }

    return {
      ...result,
      details: { ...result.details, subscription, syncMode: fullResync ? 'full' : 'incremental' }
    };
  }
);
