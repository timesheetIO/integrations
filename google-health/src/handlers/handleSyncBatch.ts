import { defineHandler, SyncModeInput } from '@timesheet/integration-sdk';
import { GoogleHealthConfig, SyncResult } from '../lib/types';
import { PLUGIN_SYSTEM, WORKOUT_ENTITY } from '../lib/exerciseSync';

/**
 * The plugin is read-only against Google Health, so the only outbound event we
 * care about is `task.delete`: when a user deletes a task that was imported
 * from a workout, drop the `workout` mapping so the next inbound sync can
 * re-create the task if the workout still exists upstream.
 */
export const handleSyncBatch = defineHandler<SyncModeInput, SyncResult, GoogleHealthConfig>(
  async (input, context) => {
    context.logger.info('Processing sync batch for Google Health', {
      sinceVersion: input.sinceVersion,
      headVersion: input.headVersion,
      changeCount: input.changes.length
    });

    let cleared = 0;
    const errors: Array<{ exerciseId: string; error: string }> = [];

    for (const change of input.changes) {
      if (change.entityType !== 'task' || change.op !== 'DELETE') {
        continue;
      }
      try {
        const existing = await context.mappings.get({
          system: PLUGIN_SYSTEM,
          entity: WORKOUT_ENTITY,
          localId: change.entityId
        });
        if (!existing) {
          continue;
        }
        await context.mappings.delete({
          system: PLUGIN_SYSTEM,
          entity: WORKOUT_ENTITY,
          localId: change.entityId
        });
        cleared += 1;
      } catch (err) {
        context.logger.warn('Failed to clear workout mapping on task delete', {
          taskId: change.entityId,
          error: String(err)
        });
        errors.push({ exerciseId: change.entityId, error: String(err) });
      }
    }

    return {
      system: PLUGIN_SYSTEM,
      status: errors.length > 0 ? 'partial' : 'completed',
      syncedCount: cleared,
      details: {
        sinceTime: String(input.sinceVersion),
        until: String(input.headVersion),
        errors: errors.length > 0 ? errors : undefined
      }
    };
  }
);
