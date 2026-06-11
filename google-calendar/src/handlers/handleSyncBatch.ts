import { defineHandler, MappingRecord, ProjectDto, SyncModeInput } from '@timesheet/integration-sdk';
import { GoogleCalendarConfig } from '../lib/types';
import { GoogleCalendarSyncResult, syncTaskToGoogleCalendar, ensureWatchChannels } from '../lib/taskSync';

const SYSTEM = 'google-calendar';
const PROJECT_ENTITY = 'project';

export const handleSyncBatch = defineHandler<SyncModeInput, GoogleCalendarSyncResult, GoogleCalendarConfig>(
  async (input, context) => {
    context.logger.info('Processing sync batch', {
      sinceVersion: input.sinceVersion,
      headVersion: input.headVersion,
      changeCount: input.changes.length,
      hasMore: input.hasMore
    });

    // Pre-load all mappings and mapped projects once for the entire batch
    const [projectMappings, taskMappings] = await Promise.all([
      context.mappings.list({ system: SYSTEM, entity: PROJECT_ENTITY }),
      context.mappings.list({ system: SYSTEM, entity: 'task' })
    ]);
    const projectMappingByLocalId = new Map<string, MappingRecord>();
    for (const mapping of projectMappings) {
      projectMappingByLocalId.set(mapping.localId, mapping);
    }
    const taskMappingByLocalId = new Map<string, MappingRecord>();
    const taskMappingByExternalId = new Map<string, MappingRecord>();
    for (const mapping of taskMappings) {
      taskMappingByLocalId.set(mapping.localId, mapping);
      if (mapping.externalId) {
        taskMappingByExternalId.set(mapping.externalId, mapping);
      }
    }

    // Pre-load mapped projects (title, color, employer) for event payload enrichment
    const projectById = new Map<string, ProjectDto>();
    const projectFetches = [...projectMappingByLocalId.keys()].map(async (projectId) => {
      try {
        const project = await context.data.getProject(projectId);
        projectById.set(projectId, project);
      } catch (err) {
        context.logger.warn('Failed to pre-load project for event enrichment', {
          projectId,
          error: String(err)
        });
      }
    });
    await Promise.all(projectFetches);

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
          context,
          { projectMappingByLocalId, taskMappingByLocalId, taskMappingByExternalId, projectById }
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

    // Renew watch channels on the last batch (no more follow-ups) or when
    // triggered by the daily schedule. ensureWatchChannels is cheap — it only
    // re-registers channels that expire within 1 hour.
    if (!input.hasMore) {
      try {
        await ensureWatchChannels(context);
      } catch (err) {
        context.logger.warn(`Watch channel renewal failed: ${String(err)}`);
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
