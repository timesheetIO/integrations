import { defineHandler, MappingRecord, SyncModeInput } from '@timesheet/integration-sdk';
import { BasecampConfig, SyncInput } from '../lib/types';
import { BasecampSyncResult, syncTimesheetTaskToBasecamp, syncTodoToBasecamp } from '../lib/taskSync';

const SYSTEM = 'basecamp';
const PROJECT_ENTITY = 'project';
const TODO_ENTITY = 'todo';
const TASK_ENTITY = 'task';

export const handleSyncBatch = defineHandler<SyncModeInput, BasecampSyncResult, BasecampConfig>(
  async (input, context) => {
    context.logger.info('Processing Basecamp sync batch', {
      sinceVersion: input.sinceVersion,
      headVersion: input.headVersion,
      changeCount: input.changes.length,
      hasMore: input.hasMore
    });

    const [projectMappings, todoMappings, taskMappings] = await Promise.all([
      context.mappings.list({ system: SYSTEM, entity: PROJECT_ENTITY }),
      context.mappings.list({ system: SYSTEM, entity: TODO_ENTITY }),
      context.mappings.list({ system: SYSTEM, entity: TASK_ENTITY })
    ]);

    const projectMappingByLocalId = new Map<string, MappingRecord>();
    for (const m of projectMappings) projectMappingByLocalId.set(m.localId, m);
    const todoMappingByLocalId = new Map<string, MappingRecord>();
    for (const m of todoMappings) todoMappingByLocalId.set(m.localId, m);
    const taskMappingByLocalId = new Map<string, MappingRecord>();
    for (const m of taskMappings) taskMappingByLocalId.set(m.localId, m);

    const caches = { projectMappingByLocalId, todoMappingByLocalId, taskMappingByLocalId };

    let syncedCount = 0;
    const errors: Array<{ entityId: string; entityType: string; error: string }> = [];

    // Process todo changes first so any task changes within the same batch can
    // find a fresh todo→Basecamp-to-do mapping to attach timesheet entries to.
    const orderedChanges = [...input.changes].sort((a, b) => {
      if (a.entityType === b.entityType) return 0;
      if (a.entityType === 'todo') return -1;
      if (b.entityType === 'todo') return 1;
      return 0;
    });

    for (const change of orderedChanges) {
      const op = change.op === 'DELETE' ? 'delete' : 'update';
      const item = change.item as unknown as SyncInput['item'];

      try {
        let result: BasecampSyncResult | null = null;

        if (change.entityType === 'todo') {
          result = await syncTodoToBasecamp(
            {
              event: `todo.${op}`,
              entityId: change.entityId,
              item
            },
            context,
            caches
          );
        } else if (change.entityType === 'task') {
          result = await syncTimesheetTaskToBasecamp(
            {
              event: `task.${op}`,
              taskId: change.entityId,
              entityId: change.entityId,
              item
            },
            context,
            caches
          );
        } else {
          continue;
        }

        if (result.status === 'synced' || result.status === 'deleted') {
          syncedCount++;
        } else if (result.status === 'skipped') {
          context.logger.debug('Change skipped', {
            entityId: change.entityId,
            entityType: change.entityType,
            reason: result.details?.reason
          });
        }
      } catch (err) {
        context.logger.error('Failed to sync change', {
          entityId: change.entityId,
          entityType: change.entityType,
          op: change.op,
          error: String(err)
        });
        errors.push({ entityId: change.entityId, entityType: change.entityType, error: String(err) });
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
