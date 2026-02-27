import {
  IntegrationContext,
  MappingRecord,
  TaskCreateInput,
  TaskDto,
  TaskUpdateInput
} from '@timesheet/integration-sdk';
import { GoogleCalendarClient } from './googleCalendarClient';
import {
  GoogleCalendarConfig,
  GoogleCalendarEvent,
  GoogleCalendarSyncInput
} from './types';

const SYSTEM = 'google-calendar';
const PROJECT_ENTITY = 'project';
const TASK_ENTITY = 'task';

export interface GoogleCalendarSyncResult {
  system: string;
  status: string;
  syncedCount: number;
  details?: Record<string, unknown>;
}

export async function syncTaskToGoogleCalendar(
  input: GoogleCalendarSyncInput,
  context: IntegrationContext<GoogleCalendarConfig>
): Promise<GoogleCalendarSyncResult> {
  const taskId = resolveTaskId(input);
  if (!taskId) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'missing-task-id' } };
  }

  const task = await loadTask(taskId, input, context);
  if (!task) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'task-not-found' } };
  }

  const projectId = task.project?.id;
  if (!projectId) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'missing-project' } };
  }

  const projectMapping = await context.mappings.get({
    system: SYSTEM,
    entity: PROJECT_ENTITY,
    localId: projectId
  });
  const externalCalendarId = projectMapping?.externalId;

  if (!externalCalendarId) {
    return {
      system: SYSTEM,
      status: 'skipped',
      syncedCount: 0,
      details: { reason: 'missing-project-mapping', projectId }
    };
  }

  const client = createClient(context);
  const taskMapping = await context.mappings.get({
    system: SYSTEM,
    entity: TASK_ENTITY,
    localId: task.id
  });

  if (task.deleted) {
    if (taskMapping?.externalId) {
      const mappedCalendarId = getMappedCalendarId(taskMapping) ?? externalCalendarId;
      await client.deleteEvent(mappedCalendarId, taskMapping.externalId);
      await context.mappings.delete({
        system: SYSTEM,
        entity: TASK_ENTITY,
        localId: task.id
      });
      return { system: SYSTEM, status: 'deleted', syncedCount: 1 };
    }
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'already-deleted' } };
  }

  const payload = buildGoogleEventPayload(task);
  let externalEvent: GoogleCalendarEvent;

  if (taskMapping?.externalId) {
    const mappedCalendarId = getMappedCalendarId(taskMapping) ?? externalCalendarId;
    externalEvent = await client.updateEvent(mappedCalendarId, taskMapping.externalId, payload);
  } else {
    const duplicate = await findEventByTimesheetId(client, externalCalendarId, task.id);
    if (duplicate?.id) {
      externalEvent = duplicate;
    } else {
      externalEvent = await client.createEvent(externalCalendarId, payload);
    }
  }

  if (!externalEvent?.id) {
    return {
      system: SYSTEM,
      status: 'failed',
      syncedCount: 0,
      details: { reason: 'missing-external-id' }
    };
  }

  await context.mappings.upsert({
    system: SYSTEM,
    entity: TASK_ENTITY,
    localId: task.id,
    externalId: externalEvent.id,
    externalLabel: externalEvent.summary ?? task.description ?? task.id,
    metadata: {
      calendarId: externalCalendarId,
      etag: externalEvent.etag ?? '',
      updated: externalEvent.updated ?? ''
    },
    syncStatus: 'SYNCED'
  });

  return {
    system: SYSTEM,
    status: 'synced',
    syncedCount: 1,
    details: { taskId: task.id, externalTaskId: externalEvent.id, calendarId: externalCalendarId }
  };
}

export async function runGoogleCalendarFullSync(
  context: IntegrationContext<GoogleCalendarConfig>
): Promise<GoogleCalendarSyncResult> {
  const projectMappings = await context.mappings.list({ system: SYSTEM, entity: PROJECT_ENTITY });
  if (projectMappings.length === 0) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'missing-project-mappings' } };
  }

  let syncedCount = 0;
  for (const mapping of projectMappings) {
    if (!mapping.externalId) {
      continue;
    }

    const perCalendarCount = await syncCalendar(context, mapping);
    syncedCount += perCalendarCount;
  }

  return {
    system: SYSTEM,
    status: 'completed',
    syncedCount,
    details: { calendarCount: projectMappings.length }
  };
}

export async function handleGoogleWebhook(
  input: GoogleCalendarSyncInput,
  context: IntegrationContext<GoogleCalendarConfig>
): Promise<GoogleCalendarSyncResult> {
  const resourceState = getHeader(input, 'x-goog-resource-state')?.toLowerCase();
  if (resourceState === 'sync') {
    return {
      system: SYSTEM,
      status: 'acknowledged',
      syncedCount: 0,
      details: { resourceState }
    };
  }

  const channelId = getHeader(input, 'x-goog-channel-id');
  const allProjectMappings = await context.mappings.list({ system: SYSTEM, entity: PROJECT_ENTITY });

  let projectMappings = allProjectMappings;
  if (channelId) {
    projectMappings = allProjectMappings.filter((mapping) => {
      const metadata = mapping.metadata ?? {};
      const watchChannelId = readMetadataString(metadata, 'watchChannelId')
        || readMetadataString(metadata, 'channelId');
      return watchChannelId === channelId;
    });
  }

  if (projectMappings.length === 0 && input.calendarId) {
    projectMappings = allProjectMappings.filter((mapping) => mapping.externalId === input.calendarId);
  }

  if (projectMappings.length === 0) {
    return {
      system: SYSTEM,
      status: 'ignored',
      syncedCount: 0,
      details: { reason: 'no-matching-calendar-mapping' }
    };
  }

  let syncedCount = 0;
  for (const mapping of projectMappings) {
    syncedCount += await syncCalendar(context, mapping);
  }

  return {
    system: SYSTEM,
    status: 'completed',
    syncedCount,
    details: {
      channelId: channelId ?? '',
      mappedCalendars: projectMappings.length
    }
  };
}

async function syncCalendar(
  context: IntegrationContext<GoogleCalendarConfig>,
  projectMapping: MappingRecord
): Promise<number> {
  if (!projectMapping.externalId) {
    return 0;
  }

  const client = createClient(context);
  const calendarId = projectMapping.externalId;
  const syncStateKey = getSyncTokenStateKey(calendarId);
  const metadataSyncToken = readMetadataString(projectMapping.metadata ?? {}, 'syncToken');

  let syncToken = (await context.state.get<string>(syncStateKey)) ?? undefined;
  if (!syncToken && metadataSyncToken) {
    syncToken = metadataSyncToken;
  }

  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  let syncedCount = 0;

  do {
    const response = await client.listEvents(calendarId, {
      showDeleted: true,
      singleEvents: true,
      syncToken,
      pageToken,
      timeMin: !syncToken ? new Date(Date.now() - (365 * 24 * 60 * 60 * 1000)).toISOString() : undefined
    });

    for (const event of response.items ?? []) {
      const synced = await syncSingleGoogleEvent(context, projectMapping, calendarId, event);
      if (synced) {
        syncedCount += 1;
      }
    }

    nextSyncToken = response.nextSyncToken ?? nextSyncToken;
    pageToken = response.nextPageToken;
  } while (pageToken);

  if (nextSyncToken) {
    await context.state.set(syncStateKey, nextSyncToken);
  }

  return syncedCount;
}

async function syncSingleGoogleEvent(
  context: IntegrationContext<GoogleCalendarConfig>,
  projectMapping: MappingRecord,
  calendarId: string,
  event: GoogleCalendarEvent
): Promise<boolean> {
  if (!event?.id) {
    return false;
  }

  const taskMapping = await context.mappings.findByExternal({
    system: SYSTEM,
    entity: TASK_ENTITY,
    externalId: event.id
  });

  if (event.status === 'cancelled') {
    if (taskMapping?.localId) {
      await context.data.deleteTask(taskMapping.localId);
      await context.mappings.delete({
        system: SYSTEM,
        entity: TASK_ENTITY,
        localId: taskMapping.localId
      });
      return true;
    }
    return false;
  }

  const dateRange = toTaskDateRange(event);
  if (!dateRange) {
    return false;
  }

  const localTaskIdFromExtendedProperties = event.extendedProperties?.private?.timesheetId;

  if (!taskMapping?.localId) {
    if (localTaskIdFromExtendedProperties) {
      return false;
    }

    const created = await context.data.createTask({
      projectId: projectMapping.localId,
      startDateTime: dateRange.startDateTime,
      endDateTime: dateRange.endDateTime,
      description: event.description ?? '',
      location: event.location
    } as TaskCreateInput);

    await context.mappings.upsert({
      system: SYSTEM,
      entity: TASK_ENTITY,
      localId: created.id,
      externalId: event.id,
      externalLabel: event.summary ?? event.id,
      metadata: {
        calendarId,
        etag: event.etag ?? '',
        updated: event.updated ?? ''
      },
      syncStatus: 'SYNCED'
    });

    return true;
  }

  const existing = await context.data.getTask(taskMapping.localId);
  const externalUpdatedAt = event.updated ? Date.parse(event.updated) : 0;
  if (existing?.lastUpdate && externalUpdatedAt > 0 && externalUpdatedAt <= existing.lastUpdate) {
    return false;
  }

  await context.data.updateTask(taskMapping.localId, {
    projectId: projectMapping.localId,
    startDateTime: dateRange.startDateTime,
    endDateTime: dateRange.endDateTime,
    description: event.description ?? '',
    location: event.location
  } as TaskUpdateInput);

  await context.mappings.upsert({
    system: SYSTEM,
    entity: TASK_ENTITY,
    localId: taskMapping.localId,
    externalId: event.id,
    externalLabel: event.summary ?? event.id,
    metadata: {
      calendarId,
      etag: event.etag ?? '',
      updated: event.updated ?? ''
    },
    syncStatus: 'SYNCED'
  });

  return true;
}

function toTaskDateRange(event: GoogleCalendarEvent): { startDateTime: string; endDateTime: string } | null {
  const startDateTime = event.start?.dateTime;
  const endDateTime = event.end?.dateTime;

  if (!startDateTime || !endDateTime) {
    return null;
  }

  const start = new Date(startDateTime);
  const end = new Date(endDateTime);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return null;
  }

  return {
    startDateTime: start.toISOString(),
    endDateTime: end.toISOString()
  };
}

function buildGoogleEventPayload(task: TaskDto): Record<string, unknown> {
  const startDateTime = task.startDateTime ? new Date(task.startDateTime).toISOString() : undefined;
  const endDateTime = task.endDateTime ? new Date(task.endDateTime).toISOString() : undefined;

  if (!startDateTime || !endDateTime) {
    throw new Error(`Task ${task.id} is missing start or end datetime.`);
  }

  const summary = task.project?.title
    ? [task.project.title, task.project.employer].filter(Boolean).join(' - ')
    : (task.description ?? 'Timesheet task');

  const creatorEmail = task.member?.email;
  const creatorDisplayName = task.member?.displayName;

  return {
    summary,
    location: task.location ?? null,
    description: task.description ?? '',
    start: {
      dateTime: startDateTime
    },
    end: {
      dateTime: endDateTime
    },
    extendedProperties: {
      private: {
        timesheetId: task.id
      }
    },
    creator: creatorEmail
      ? {
          email: creatorEmail,
          displayName: creatorDisplayName
        }
      : undefined
  };
}

async function findEventByTimesheetId(
  client: GoogleCalendarClient,
  calendarId: string,
  taskId: string
): Promise<GoogleCalendarEvent | null> {
  const response = await client.listEvents(calendarId, {
    privateExtendedProperty: `timesheetId=${taskId}`,
    maxResults: 1,
    singleEvents: true
  });

  const item = (response.items ?? [])[0];
  return item ?? null;
}

function getMappedCalendarId(mapping: MappingRecord): string | undefined {
  const metadata = mapping.metadata ?? {};
  return readMetadataString(metadata, 'calendarId');
}

function getSyncTokenStateKey(calendarId: string): string {
  return `google-calendar:sync-token:${calendarId}`;
}

function createClient(context: IntegrationContext<GoogleCalendarConfig>): GoogleCalendarClient {
  return new GoogleCalendarClient({
    getAccessToken: () => context.credentials.getAccessToken('google'),
    refreshAccessToken: () => context.credentials.refreshToken('google')
  });
}

async function loadTask(
  taskId: string,
  input: GoogleCalendarSyncInput,
  context: IntegrationContext<GoogleCalendarConfig>
): Promise<TaskDto | null> {
  try {
    return await context.data.getTask(taskId);
  } catch {
    if (input?.item && typeof input.item === 'object') {
      return input.item as TaskDto;
    }
    return null;
  }
}

function resolveTaskId(input: GoogleCalendarSyncInput): string | undefined {
  return input?.taskId
    || input?.item?.taskId
    || input?.item?.id;
}

function getHeader(input: GoogleCalendarSyncInput, name: string): string | undefined {
  const mergedHeaders: Record<string, unknown> = {
    ...(input?.headers ?? {})
  };

  if (input?.body && typeof input.body === 'object') {
    const nestedHeaders = (input.body as { headers?: Record<string, unknown> }).headers;
    if (nestedHeaders && typeof nestedHeaders === 'object') {
      Object.assign(mergedHeaders, nestedHeaders);
    }
  }

  const key = Object.keys(mergedHeaders).find((header) => header.toLowerCase() === name.toLowerCase());
  if (!key) {
    return undefined;
  }

  const value = mergedHeaders[key];
  return value === undefined || value === null ? undefined : String(value);
}

function readMetadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  return undefined;
}
