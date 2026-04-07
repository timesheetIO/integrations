import { defineHandler, SyncModeInput } from '@timesheet/integration-sdk';
import { QuickBooksConfig } from '../lib/types';
import { QuickBooksSyncResult, syncTaskToQuickBooks } from '../lib/taskSync';

export const handleSyncBatch = defineHandler<SyncModeInput, QuickBooksSyncResult, QuickBooksConfig>(
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
        const result = await syncTaskToQuickBooks(
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
      system: 'quickbooks',
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
