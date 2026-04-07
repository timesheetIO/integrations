import { defineHandler, SyncModeInput } from '@timesheet/integration-sdk';
import { GoogleCalendarConfig } from '../lib/types';
import { GoogleCalendarSyncResult, syncTaskToGoogleCalendar } from '../lib/taskSync';

export const handleSyncBatch = defineHandler<SyncModeInput, GoogleCalendarSyncResult, GoogleCalendarConfig>(
  async (input, context) => {
    context.logger.info('Processing sync batch', {
      sinceVersion: input.sinceVersion,
      headVersion: input.headVersion,
      changeCount: input.changes.length,
      hasMore: input.hasMore
    });

    let syncedCount = 0;
    const errors: Array<{ entityId: string; error: string }> = [];

    for (const change of input.changes) {
      if (change.entityType !== 'task') {
        continue;
      }

      try {
        const event = change.op === 'DELETE' ? 'task.delete' : 'task.update';
        const result = await syncTaskToGoogleCalendar(
          {
            event,
            taskId: change.entityId,
            item: change.item as Record<string, unknown> & { id?: string }
          },
          context
        );

        if (result.status === 'synced' || result.status === 'deleted') {
          syncedCount++;
        }
      } catch (err) {
        context.logger.error('Failed to sync change', {
          entityId: change.entityId,
          op: change.op,
          error: String(err)
        });
        errors.push({ entityId: change.entityId, error: String(err) });
      }
    }

    return {
      system: 'google-calendar',
      status: errors.length > 0 ? 'partial' : 'completed',
      syncedCount,
      details: {
        sinceVersion: input.sinceVersion,
        headVersion: input.headVersion,
        totalChanges: input.changes.length,
        hasMore: input.hasMore,
        errors: errors.length > 0 ? errors : undefined
      }
    };
  }
);
