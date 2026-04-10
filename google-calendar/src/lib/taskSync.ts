import {
  IntegrationContext,
  MappingRecord,
  ProjectDto,
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

export interface SyncBatchCaches {
  projectMappingByLocalId?: Map<string, MappingRecord>;
  taskMappingByLocalId?: Map<string, MappingRecord>;
  projectById?: Map<string, ProjectDto>;
}

// Shared client instance for batch execution — avoids re-fetching the access token per change.
let sharedClient: GoogleCalendarClient | null = null;

export async function syncTaskToGoogleCalendar(
  input: GoogleCalendarSyncInput,
  context: IntegrationContext<GoogleCalendarConfig>,
  caches?: SyncBatchCaches
): Promise<GoogleCalendarSyncResult> {
  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  if (syncDirection === 'google-to-timesheet' || syncDirection === 'external-to-timesheet') {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'sync-direction-mismatch' } };
  }

  const taskId = resolveTaskId(input);
  if (!taskId) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'missing-task-id' } };
  }

  const task = await loadTask(taskId, input, context, caches);
  if (!task) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'task-not-found' } };
  }

  const projectId = task.project?.id ?? (input.item as Record<string, unknown>)?.projectId as string | undefined;
  if (!projectId) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'missing-project' } };
  }

  // Use pre-loaded project mapping from cache if available
  let projectMapping: MappingRecord | null | undefined;
  if (caches?.projectMappingByLocalId) {
    projectMapping = caches.projectMappingByLocalId.get(projectId) ?? null;
  } else {
    projectMapping = await context.mappings.get({
      system: SYSTEM,
      entity: PROJECT_ENTITY,
      localId: projectId
    });
  }
  const externalCalendarId = projectMapping?.externalId;

  if (!externalCalendarId) {
    return {
      system: SYSTEM,
      status: 'skipped',
      syncedCount: 0,
      details: { reason: 'missing-project-mapping', projectId }
    };
  }

  const client = getOrCreateClient(context);

  // Use pre-loaded task mapping from cache if available
  let taskMapping: MappingRecord | null | undefined;
  if (caches?.taskMappingByLocalId) {
    taskMapping = caches.taskMappingByLocalId.get(task.id) ?? null;
  } else {
    taskMapping = await context.mappings.get({
      system: SYSTEM,
      entity: TASK_ENTITY,
      localId: task.id
    });
  }

  if (task.running) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'task-running' } };
  }

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

  let payload: Record<string, unknown>;
  try {
    payload = buildGoogleEventPayload(task);
  } catch (err) {
    context.logger.warn('Failed to build event payload', { taskId: task.id, error: String(err) });
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'invalid-task-data', taskId: task.id } };
  }
  let externalEvent: GoogleCalendarEvent;

  if (taskMapping?.externalId) {
    const mappedCalendarId = getMappedCalendarId(taskMapping) ?? externalCalendarId;
    context.logger.info('Updating event', { taskId: task.id, calendarId: mappedCalendarId, eventId: taskMapping.externalId });
    externalEvent = await client.updateEvent(mappedCalendarId, taskMapping.externalId, payload);
  } else {
    const duplicate = await findEventByTimesheetId(client, externalCalendarId, task.id);
    if (duplicate?.id) {
      context.logger.info('Found existing event by timesheetId', { taskId: task.id, eventId: duplicate.id });
      externalEvent = duplicate;
    } else {
      context.logger.info('Creating event', { taskId: task.id, calendarId: externalCalendarId, summary: payload.summary });
      externalEvent = await client.createEvent(externalCalendarId, payload);
      context.logger.info('Created event', { taskId: task.id, eventId: externalEvent?.id });
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

  const upsertedMapping: MappingRecord = {
    localId: task.id,
    externalId: externalEvent.id,
    externalLabel: externalEvent.summary ?? task.description ?? task.id,
    metadata: {
      calendarId: externalCalendarId,
      etag: externalEvent.etag ?? '',
      updated: externalEvent.updated ?? ''
    },
    syncStatus: 'SYNCED'
  };

  await context.mappings.upsert({
    system: SYSTEM,
    entity: TASK_ENTITY,
    ...upsertedMapping
  });

  // Update in-memory cache so subsequent changes in the same batch see this mapping
  if (caches?.taskMappingByLocalId) {
    caches.taskMappingByLocalId.set(task.id, upsertedMapping);
  }

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
  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  const allowInbound = syncDirection !== 'timesheet-to-google' && syncDirection !== 'timesheet-to-external';

  const projectMappings = await context.mappings.list({ system: SYSTEM, entity: PROJECT_ENTITY });
  if (projectMappings.length === 0) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'missing-project-mappings' } };
  }

  let syncedCount = 0;
  if (allowInbound) {
    for (const mapping of projectMappings) {
      if (!mapping.externalId) {
        continue;
      }

      const perCalendarCount = await syncCalendar(context, mapping);
      syncedCount += perCalendarCount;
    }
  }

  return {
    system: SYSTEM,
    status: 'completed',
    syncedCount,
    details: { calendarCount: projectMappings.length, syncDirection }
  };
}

export async function handleGoogleWebhook(
  input: GoogleCalendarSyncInput,
  context: IntegrationContext<GoogleCalendarConfig>
): Promise<GoogleCalendarSyncResult> {
  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  if (syncDirection === 'timesheet-to-google' || syncDirection === 'timesheet-to-external') {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'sync-direction-mismatch' } };
  }

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

  try {
    return await fetchAndSyncEvents(context, client, projectMapping, calendarId, syncStateKey, syncToken);
  } catch (err) {
    // Google returns 400 or 410 when a sync token is invalid/expired — clear it and do a full resync
    const errMsg = String(err);
    if (syncToken && (errMsg.includes('(410)') || errMsg.includes('Invalid sync token'))) {
      context.logger.warn('Sync token expired, performing full resync', { calendarId });
      await context.state.delete(syncStateKey);
      return await fetchAndSyncEvents(context, client, projectMapping, calendarId, syncStateKey, undefined);
    }
    throw err;
  }
}

async function fetchAndSyncEvents(
  context: IntegrationContext<GoogleCalendarConfig>,
  client: GoogleCalendarClient,
  projectMapping: MappingRecord,
  calendarId: string,
  syncStateKey: string,
  syncToken: string | undefined
): Promise<number> {
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
  let startRaw = event.start?.dateTime;
  let endRaw = event.end?.dateTime;

  // Handle all-day events (date field instead of dateTime)
  if (!startRaw && event.start?.date) {
    startRaw = `${event.start.date}T00:00:00+00:00`;
  }
  if (!endRaw && event.end?.date) {
    endRaw = `${event.end.date}T00:00:00+00:00`;
  }

  if (!startRaw || !endRaw) {
    return null;
  }

  const start = new Date(startRaw);
  const end = new Date(endRaw);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return null;
  }

  return {
    startDateTime: toTimesheetDateTime(start),
    endDateTime: toTimesheetDateTime(end)
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

function getOrCreateClient(context: IntegrationContext<GoogleCalendarConfig>): GoogleCalendarClient {
  if (!sharedClient) {
    sharedClient = createClient(context);
  }
  return sharedClient;
}

async function loadTask(
  taskId: string,
  input: GoogleCalendarSyncInput,
  context: IntegrationContext<GoogleCalendarConfig>,
  caches?: SyncBatchCaches
): Promise<TaskDto | null> {
  // Prefer inline item data from sync change — avoids a full getTask round-trip
  // (which populates pauses, notes, expenses, tags unnecessarily).
  // SyncChange payloads use flat fields (projectId) while the API returns
  // nested objects (project: { id, title }). Normalize and enrich with project data.
  if (input?.item && typeof input.item === 'object' && input.item.id) {
    const raw = input.item as Record<string, unknown>;
    const projectId = raw.projectId as string | undefined;
    if (!raw.project && projectId) {
      // Only enrich with project data if the project is mapped (has a calendar).
      // Unmapped projects will be skipped at the mapping check anyway.
      let project: ProjectDto | Record<string, unknown> | undefined;
      if (caches?.projectById) {
        project = caches.projectById.get(projectId);
      }
      raw.project = project ?? { id: projectId };
    }
    return raw as unknown as TaskDto;
  }
  try {
    return await context.data.getTask(taskId);
  } catch {
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

export async function ensureWatchChannels(
  context: IntegrationContext<GoogleCalendarConfig>
): Promise<void> {
  const webhookUrl = context.metadata?.webhooks?.['integration-webhook'];
  if (!webhookUrl) {
    context.logger.info('No webhook URL available — skipping watch channel registration');
    return;
  }

  const projectMappings = await context.mappings.list({ system: SYSTEM, entity: PROJECT_ENTITY });
  if (projectMappings.length === 0) {
    return;
  }

  const client = createClient(context);
  const now = Date.now();
  const watchTtlSeconds = 7 * 24 * 60 * 60; // 7 days

  for (const mapping of projectMappings) {
    if (!mapping.externalId) {
      continue;
    }

    const metadata = mapping.metadata ?? {};
    const existingExpiration = readMetadataString(metadata, 'watchExpiration');
    if (existingExpiration) {
      const expiresAt = Number(existingExpiration);
      if (expiresAt > now + 3600_000) {
        // Watch still has > 1 hour remaining, skip
        continue;
      }

      // Stop the old channel before creating a new one
      const oldChannelId = readMetadataString(metadata, 'watchChannelId');
      const oldResourceId = readMetadataString(metadata, 'watchResourceId');
      if (oldChannelId && oldResourceId) {
        try {
          await client.stopWatch(oldChannelId, oldResourceId);
        } catch (err) {
          context.logger.warn('Failed to stop old watch channel', { calendarId: mapping.externalId, error: String(err) });
        }
      }
    }

    try {
      const channelId = `ts-${context.installationId}-${mapping.externalId}-${now}`.substring(0, 64);
      context.logger.info(`Registering watch: calendar=${mapping.externalId} webhook=${webhookUrl} channelId=${channelId}`);
      const watchResult = await client.watchEvents(mapping.externalId, channelId, webhookUrl, watchTtlSeconds);

      await context.mappings.upsert({
        system: SYSTEM,
        entity: PROJECT_ENTITY,
        localId: mapping.localId,
        externalId: mapping.externalId,
        externalLabel: mapping.externalLabel,
        metadata: {
          ...metadata,
          watchChannelId: channelId,
          watchResourceId: watchResult.resourceId ?? '',
          watchExpiration: watchResult.expiration ?? String(now + watchTtlSeconds * 1000)
        },
        syncStatus: 'SYNCED'
      });

      context.logger.info(`Watch channel registered: calendar=${mapping.externalId} resourceId=${watchResult.resourceId} expiration=${watchResult.expiration}`);
    } catch (err) {
      context.logger.error(`Failed to register watch channel: calendar=${mapping.externalId} error=${String(err)}`);
    }
  }
}

/** Format a Date to the offset format the Timesheet backend expects: yyyy-MM-dd'T'HH:mm:ss+00:00 */
function toTimesheetDateTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

function readMetadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  return undefined;
}
