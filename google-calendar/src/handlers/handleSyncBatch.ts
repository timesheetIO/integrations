import { defineHandler, MappingRecord, ProjectDto, SyncModeInput } from '@timesheet/integration-sdk';
import { GoogleCalendarConfig } from '../lib/types';
import { GoogleCalendarSyncResult, syncTaskToGoogleCalendar } from '../lib/taskSync';

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
    for (const mapping of taskMappings) {
      taskMappingByLocalId.set(mapping.localId, mapping);
    }

    // Pre-load mapped projects (title, color, employer) for event payload enrichment
    const projectById = new Map<string, ProjectDto>();
    const projectFetches = [...projectMappingByLocalId.keys()].map(async (projectId) => {
      try {
        const project = await context.data.getProject(projectId);
        projectById.set(projectId, project);
      } catch { /* project may have been deleted */ }
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
          { projectMappingByLocalId, taskMappingByLocalId, projectById }
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
