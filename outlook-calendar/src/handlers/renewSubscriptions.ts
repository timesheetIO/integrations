import { defineHandler } from '@timesheet/integration-sdk';
import { OutlookCalendarConfig } from '../lib/types';
import { OutlookCalendarSyncResult, allowsInbound, ensureSubscription, runInboundSync } from '../lib/taskSync';

const SYSTEM = 'outlook-calendar';

/**
 * Daily: renews the mailbox subscription before Graph lets it expire (at most
 * 10,080 minutes), then reads the change feeds once. The pass catches changes
 * whose notification never arrived and calendars shared with the user, which
 * a subscription cannot cover.
 *
 * The trigger carries no `mode: "sync"`, so the dispatcher queues it
 * unconditionally instead of routing it through the change-set gate.
 */
export const renewSubscriptions = defineHandler<void, OutlookCalendarSyncResult, OutlookCalendarConfig>(
  async (_input, context) => {
    if (!allowsInbound(context)) {
      return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'sync-direction-mismatch' } };
    }

    const projectMappings = await context.mappings.list({ system: SYSTEM, entity: 'project' });
    if (!projectMappings.some(mapping => mapping.externalId)) {
      return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'missing-project-mappings' } };
    }

    let subscription: string;
    try {
      subscription = await ensureSubscription(context);
    } catch (err) {
      context.logger.error('Failed to renew the Outlook subscription', { error: String(err) });
      subscription = 'failed';
    }

    const result = await runInboundSync(context, { projectMappings });
    return { ...result, details: { ...result.details, subscription } };
  }
);
