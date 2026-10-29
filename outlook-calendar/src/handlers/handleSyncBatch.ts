import { defineHandler, ProjectDto, SyncModeInput } from '@timesheet/integration-sdk';
import { OutlookCalendarConfig } from '../lib/types';
import {
  OutlookCalendarSyncResult,
  allowsInbound,
  buildMappingCaches,
  ensureSubscription,
  syncTaskToOutlook
} from '../lib/taskSync';

const SYSTEM = 'outlook-calendar';

export const handleSyncBatch = defineHandler<SyncModeInput, OutlookCalendarSyncResult, OutlookCalendarConfig>(
  async (input, context) => {
    context.logger.info('Processing sync batch', {
      sinceVersion: input.sinceVersion,
      headVersion: input.headVersion,
      changeCount: input.changes.length,
      hasMore: input.hasMore
    });

    // Load all mappings and mapped projects once for the whole batch.
    const [projectMappings, taskMappings] = await Promise.all([
      context.mappings.list({ system: SYSTEM, entity: 'project' }),
      context.mappings.list({ system: SYSTEM, entity: 'task' })
    ]);
    const caches = buildMappingCaches(projectMappings, taskMappings);

    // Project title and employer make up the subject of Timesheet-originated events.
    const projectById = new Map<string, ProjectDto>();
    await Promise.all([...(caches.projectMappingByLocalId?.keys() ?? [])].map(async (projectId) => {
      try {
        projectById.set(projectId, await context.data.getProject(projectId));
      } catch (err) {
        context.logger.warn('Failed to pre-load project for event enrichment', { projectId, error: String(err) });
      }
    }));
    caches.projectById = projectById;

    let syncedCount = 0;
    const errors: Array<{ entityId: string; error: string }> = [];

    for (const change of input.changes) {
      if (change.entityType !== 'task') {
        continue;
      }

      try {
        const result = await syncTaskToOutlook(
          {
            event: change.op === 'DELETE' ? 'task.delete' : 'task.update',
            taskId: change.entityId,
            item: change.item as Record<string, unknown> & { id?: string }
          },
          context,
          caches
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

    // On the last batch, make sure Outlook changes keep arriving. Cheap when
    // the subscription is current: one state read.
    if (!input.hasMore && allowsInbound(context) && projectMappings.some(mapping => mapping.externalId)) {
      try {
        await ensureSubscription(context);
      } catch (err) {
        context.logger.warn(`Outlook subscription check failed: ${String(err)}`);
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
