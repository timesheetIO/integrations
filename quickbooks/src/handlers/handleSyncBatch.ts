import { defineHandler, MappingRecord, SyncModeInput } from '@timesheet/integration-sdk';
import { QuickBooksConfig, SyncInput } from '../lib/types';
import { QuickBooksSyncResult, syncTaskToQuickBooks } from '../lib/taskSync';

const SYSTEM = 'quickbooks';
const PROJECT_ENTITY = 'project';
const USER_ENTITY = 'user';
const TASK_ENTITY = 'task';

export const handleSyncBatch = defineHandler<SyncModeInput, QuickBooksSyncResult, QuickBooksConfig>(
  async (input, context) => {
    context.logger.info('Processing sync batch', {
      sinceVersion: input.sinceVersion,
      headVersion: input.headVersion,
      changeCount: input.changes.length,
      hasMore: input.hasMore
    });

    const [projectMappings, userMappings, taskMappings] = await Promise.all([
      context.mappings.list({ system: SYSTEM, entity: PROJECT_ENTITY }),
      context.mappings.list({ system: SYSTEM, entity: USER_ENTITY }),
      context.mappings.list({ system: SYSTEM, entity: TASK_ENTITY })
    ]);

    const projectMappingByLocalId = new Map<string, MappingRecord>();
    for (const mapping of projectMappings) {
      projectMappingByLocalId.set(mapping.localId, mapping);
    }
    const userMappingByLocalId = new Map<string, MappingRecord>();
    for (const mapping of userMappings) {
      userMappingByLocalId.set(mapping.localId, mapping);
    }
    const taskMappingByLocalId = new Map<string, MappingRecord>();
    for (const mapping of taskMappings) {
      taskMappingByLocalId.set(mapping.localId, mapping);
    }

    let syncedCount = 0;
    const errors: Array<{ entityId: string; error: string }> = [];

    for (const change of input.changes) {
      if (change.entityType !== 'task') {
        continue;
      }

      try {
        const event = change.op === 'DELETE' ? 'task.delete' : 'task.update';
        const item = change.item as unknown as SyncInput['item'];
        const result = await syncTaskToQuickBooks(
          {
            event,
            taskId: change.entityId,
            item
          },
          context,
          { projectMappingByLocalId, userMappingByLocalId, taskMappingByLocalId }
        );

        if (result.status === 'synced' || result.status === 'deleted') {
          syncedCount++;
        } else if (result.status === 'skipped') {
          context.logger.debug('Change skipped', { entityId: change.entityId, reason: result.details?.reason });
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
      system: SYSTEM,
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
