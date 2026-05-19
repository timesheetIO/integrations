import { defineHandler, MappingRecord, SyncModeInput } from '@timesheet/integration-sdk';
import { ClickUpConfig, SyncInput } from '../lib/types';
import { ClickUpSyncResult, syncTaskToClickUp, syncTodoToClickUp } from '../lib/taskSync';
import { ClickUpApiError, isClickUpPlanLimitError } from '../lib/clickupClient';

const SYSTEM = 'clickup';
const PROJECT_ENTITY = 'project';
const USER_ENTITY = 'user';
const TASK_ENTITY = 'task';
const TODO_ENTITY = 'todo';

export const handleSyncBatch = defineHandler<SyncModeInput, ClickUpSyncResult, ClickUpConfig>(
  async (input, context) => {
    context.logger.info('Processing sync batch', {
      sinceVersion: input.sinceVersion,
      headVersion: input.headVersion,
      changeCount: input.changes.length,
      hasMore: input.hasMore
    });

    const [projectMappings, taskMappings, todoMappings, userMappings] = await Promise.all([
      context.mappings.list({ system: SYSTEM, entity: PROJECT_ENTITY }),
      context.mappings.list({ system: SYSTEM, entity: TASK_ENTITY }),
      context.mappings.list({ system: SYSTEM, entity: TODO_ENTITY }),
      context.mappings.list({ system: SYSTEM, entity: USER_ENTITY })
    ]);

    const projectMappingByLocalId = new Map<string, MappingRecord>();
    for (const mapping of projectMappings) {
      projectMappingByLocalId.set(mapping.localId, mapping);
    }
    const taskMappingByLocalId = new Map<string, MappingRecord>();
    for (const mapping of taskMappings) {
      taskMappingByLocalId.set(mapping.localId, mapping);
    }
    const todoMappingByLocalId = new Map<string, MappingRecord>();
    for (const mapping of todoMappings) {
      todoMappingByLocalId.set(mapping.localId, mapping);
    }
    const userMappingByLocalId = new Map<string, MappingRecord>();
    for (const mapping of userMappings) {
      userMappingByLocalId.set(mapping.localId, mapping);
    }

    let syncedCount = 0;
    const errors: Array<{ entityType: string; entityId: string; error: string }> = [];

    // ToDos first so their mapping exists when tasks resolve `tid` from them.
    const ordered = [...input.changes].sort((a, b) => {
      const aTodo = a.entityType === 'todo' ? 0 : 1;
      const bTodo = b.entityType === 'todo' ? 0 : 1;
      return aTodo - bTodo;
    });

    for (const change of ordered) {
      if (change.entityType !== 'task' && change.entityType !== 'todo') {
        continue;
      }

      try {
        const event = `${change.entityType}.${change.op === 'DELETE' ? 'delete' : 'update'}`;
        const item = change.item as unknown as SyncInput['item'];
        const result = change.entityType === 'todo'
          ? await syncTodoToClickUp(
              { event, todoId: change.entityId, item },
              context,
              { projectMappingByLocalId, taskMappingByLocalId, todoMappingByLocalId, userMappingByLocalId }
            )
          : await syncTaskToClickUp(
              { event, taskId: change.entityId, item },
              context,
              { projectMappingByLocalId, taskMappingByLocalId, todoMappingByLocalId, userMappingByLocalId }
            );

        if (result.status === 'synced' || result.status === 'deleted') {
          syncedCount++;
        } else if (result.status === 'skipped') {
          context.logger.debug('Change skipped', {
            entityType: change.entityType,
            entityId: change.entityId,
            reason: result.details?.reason
          });
        }
      } catch (err) {
        if (isClickUpPlanLimitError(err)) {
          const friendly = formatPlanLimitMessage(err);
          context.logger.warn('ClickUp plan limit reached — change not synced', {
            entityType: change.entityType,
            entityId: change.entityId,
            op: change.op,
            ecode: err.ecode,
            apiMessage: err.apiMessage
          });
          errors.push({ entityType: change.entityType, entityId: change.entityId, error: friendly });
          continue;
        }
        context.logger.error('Failed to sync change', {
          entityType: change.entityType,
          entityId: change.entityId,
          op: change.op,
          error: String(err)
        });
        errors.push({ entityType: change.entityType, entityId: change.entityId, error: String(err) });
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

function formatPlanLimitMessage(err: ClickUpApiError): string {
  const detail = err.apiMessage ?? 'A ClickUp plan limit has been reached on this workspace.';
  const code = err.ecode ?? 'unknown';
  return `ClickUp plan limit reached: ${detail} Upgrade the ClickUp workspace to continue syncing (ClickUp error ${code}).`;
}
