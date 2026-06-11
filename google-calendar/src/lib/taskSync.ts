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
  taskMappingByExternalId?: Map<string, MappingRecord>;
  projectById?: Map<string, ProjectDto>;
}

interface SyncCalendarOptions {
  caches?: SyncBatchCaches;
  fallbackUpdatedMin?: string;
  lockTtlSeconds?: number;
}

interface FetchAndSyncOptions {
  fallbackUpdatedMin?: string;
}

interface FullSyncOptions {
  fallbackUpdatedMin?: string;
  lockTtlSeconds?: number;
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
  putTaskMappingInCaches(caches, upsertedMapping);

  return {
    system: SYSTEM,
    status: 'synced',
    syncedCount: 1,
    details: { taskId: task.id, externalTaskId: externalEvent.id, calendarId: externalCalendarId }
  };
}

export async function runGoogleCalendarFullSync(
  context: IntegrationContext<GoogleCalendarConfig>,
  options: FullSyncOptions = {}
): Promise<GoogleCalendarSyncResult> {
  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  const allowInbound = syncDirection !== 'timesheet-to-google' && syncDirection !== 'timesheet-to-external';

  const projectMappings = await context.mappings.list({ system: SYSTEM, entity: PROJECT_ENTITY });
  if (projectMappings.length === 0) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'missing-project-mappings' } };
  }
  const caches = buildMappingCaches(projectMappings);

  let syncedCount = 0;
  if (allowInbound) {
    for (const mapping of projectMappings) {
      if (!mapping.externalId) {
        continue;
      }

      const perCalendarCount = await syncCalendar(context, mapping, {
        caches,
        fallbackUpdatedMin: options.fallbackUpdatedMin,
        lockTtlSeconds: options.lockTtlSeconds
      });
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
  const resourceUri = getHeader(input, 'x-goog-resource-uri');
  const resourceCalendarId = extractCalendarIdFromResourceUri(resourceUri);
  const allProjectMappings = await context.mappings.list({ system: SYSTEM, entity: PROJECT_ENTITY });
  const caches = buildMappingCaches(allProjectMappings);

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

  if (projectMappings.length === 0 && resourceCalendarId) {
    projectMappings = allProjectMappings.filter((mapping) => mapping.externalId === resourceCalendarId);
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
  const seenCalendarIds = new Set<string>();
  const fallbackUpdatedMin = toTimesheetDateTime(new Date(Date.now() - (7 * 24 * 60 * 60 * 1000)));
  for (const mapping of projectMappings) {
    if (!mapping.externalId || seenCalendarIds.has(mapping.externalId)) {
      continue;
    }
    seenCalendarIds.add(mapping.externalId);
    syncedCount += await syncCalendar(context, mapping, {
      caches,
      fallbackUpdatedMin,
      lockTtlSeconds: 15 * 60
    });
  }

  return {
    system: SYSTEM,
    status: 'completed',
    syncedCount,
    details: {
      channelId: channelId ?? '',
      resourceCalendarId: resourceCalendarId ?? '',
      mappedCalendars: projectMappings.length
    }
  };
}

async function syncCalendar(
  context: IntegrationContext<GoogleCalendarConfig>,
  projectMapping: MappingRecord,
  options: SyncCalendarOptions = {}
): Promise<number> {
  if (!projectMapping.externalId) {
    return 0;
  }

  const client = createClient(context);
  const calendarId = projectMapping.externalId;
  const lockKey = getSyncLockStateKey(calendarId);
  let acquiredLock = false;
  if (options.lockTtlSeconds && options.lockTtlSeconds > 0) {
    try {
      const lockOptions = { ttlSeconds: options.lockTtlSeconds, ifAbsent: true };
      await context.state.set(lockKey, Date.now(), lockOptions);
      acquiredLock = true;
    } catch (err) {
      if (isStateConflictError(err)) {
        context.logger.info('Calendar sync already in progress, skipping duplicate webhook', { calendarId });
        return 0;
      }
      throw err;
    }
  }

  const syncStateKey = getSyncTokenStateKey(calendarId);
  try {
    const metadataSyncToken = readMetadataString(projectMapping.metadata ?? {}, 'syncToken');

    let syncToken = (await context.state.get<string>(syncStateKey)) ?? undefined;
    if (!syncToken && metadataSyncToken) {
      syncToken = metadataSyncToken;
    }

    try {
      return await fetchAndSyncEvents(
        context,
        client,
        projectMapping,
        calendarId,
        syncStateKey,
        syncToken,
        options.caches,
        { fallbackUpdatedMin: options.fallbackUpdatedMin }
      );
    } catch (err) {
      // Google returns 400 or 410 when a sync token is invalid/expired. For
      // webhook delivery, avoid a heavy one-year resync and fetch recently
      // updated events only; scheduled/manual sync can still do the full repair.
      const errMsg = String(err);
      if (syncToken && (errMsg.includes('(410)') || errMsg.includes('Invalid sync token'))) {
        context.logger.warn(
          options.fallbackUpdatedMin
            ? 'Sync token expired, performing recent webhook resync'
            : 'Sync token expired, performing full resync',
          { calendarId, fallbackUpdatedMin: options.fallbackUpdatedMin ?? '' }
        );
        await context.state.delete(syncStateKey);
        return await fetchAndSyncEvents(
          context,
          client,
          projectMapping,
          calendarId,
          syncStateKey,
          undefined,
          options.caches,
          { fallbackUpdatedMin: options.fallbackUpdatedMin }
        );
      }
      throw err;
    }
  } finally {
    if (acquiredLock) {
      try {
        await context.state.delete(lockKey);
      } catch (err) {
        context.logger.warn('Failed to clear calendar sync lock', { calendarId, error: String(err) });
      }
    }
  }
}

function isStateConflictError(err: unknown): boolean {
  const message = String(err);
  return message.includes('Timesheet API request failed (409)')
    || message.includes('StateConflict')
    || message.includes('State key already exists');
}

async function fetchAndSyncEvents(
  context: IntegrationContext<GoogleCalendarConfig>,
  client: GoogleCalendarClient,
  projectMapping: MappingRecord,
  calendarId: string,
  syncStateKey: string,
  syncToken: string | undefined,
  caches?: SyncBatchCaches,
  options: FetchAndSyncOptions = {}
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
      timeMin: !syncToken && !options.fallbackUpdatedMin
        ? new Date(Date.now() - (365 * 24 * 60 * 60 * 1000)).toISOString()
        : undefined,
      updatedMin: !syncToken ? options.fallbackUpdatedMin : undefined
    });

    for (const event of response.items ?? []) {
      const synced = await syncSingleGoogleEvent(context, projectMapping, calendarId, event, caches);
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
  event: GoogleCalendarEvent,
  caches?: SyncBatchCaches
): Promise<boolean> {
  if (!event?.id) {
    return false;
  }

  const taskMapping = await getTaskMappingByExternalId(context, event.id, caches);

  if (event.status === 'cancelled') {
    if (taskMapping?.localId) {
      await context.data.deleteTask(taskMapping.localId);
      await context.mappings.delete({
        system: SYSTEM,
        entity: TASK_ENTITY,
        localId: taskMapping.localId
      });
      removeTaskMappingFromCaches(caches, taskMapping);
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
    putTaskMappingInCaches(caches, {
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

  const externalUpdatedAt = event.updated ? Date.parse(event.updated) : 0;
  const mappedExternalUpdated = readMetadataString(taskMapping.metadata ?? {}, 'updated');
  const mappedExternalUpdatedAt = mappedExternalUpdated ? Date.parse(mappedExternalUpdated) : 0;
  if (externalUpdatedAt > 0 && mappedExternalUpdatedAt > 0 && externalUpdatedAt <= mappedExternalUpdatedAt) {
    return false;
  }

  const existing = await context.data.getTask(taskMapping.localId);
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
  putTaskMappingInCaches(caches, {
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

function buildMappingCaches(projectMappings: MappingRecord[], taskMappings: MappingRecord[] = []): SyncBatchCaches {
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

  return {
    projectMappingByLocalId,
    taskMappingByLocalId,
    taskMappingByExternalId
  };
}

async function getTaskMappingByExternalId(
  context: IntegrationContext<GoogleCalendarConfig>,
  externalId: string,
  caches?: SyncBatchCaches
): Promise<MappingRecord | null> {
  if (caches?.taskMappingByExternalId?.has(externalId)) {
    return caches.taskMappingByExternalId.get(externalId) ?? null;
  }

  const mapping = await context.mappings.findByExternal({
    system: SYSTEM,
    entity: TASK_ENTITY,
    externalId
  });
  if (mapping) {
    putTaskMappingInCaches(caches, mapping);
  }
  return mapping;
}

function putTaskMappingInCaches(caches: SyncBatchCaches | undefined, mapping: MappingRecord): void {
  caches?.taskMappingByLocalId?.set(mapping.localId, mapping);
  if (mapping.externalId) {
    caches?.taskMappingByExternalId?.set(mapping.externalId, mapping);
  }
}

function removeTaskMappingFromCaches(caches: SyncBatchCaches | undefined, mapping: MappingRecord): void {
  caches?.taskMappingByLocalId?.delete(mapping.localId);
  if (mapping.externalId) {
    caches?.taskMappingByExternalId?.delete(mapping.externalId);
  }
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

  // Validate by parsing, but preserve the original string with timezone offset.
  // Google sends e.g. "2026-04-10T09:00:00+02:00" — pass through directly so the
  // backend stores the correct timezone instead of converting to UTC.
  if (Number.isNaN(new Date(startRaw).getTime()) || Number.isNaN(new Date(endRaw).getTime())) {
    return null;
  }

  return {
    startDateTime: startRaw,
    endDateTime: endRaw
  };
}

function buildGoogleEventPayload(task: TaskDto): Record<string, unknown> {
  const startDateTime = task.startDateTime;
  const endDateTime = task.endDateTime;

  if (!startDateTime || !endDateTime) {
    throw new Error(`Task ${task.id} is missing start or end datetime.`);
  }

  const projectSummary = task.project?.title
    ? [task.project.title, task.project.employer].filter(Boolean).join(' - ')
    : '';
  const description = typeof task.description === 'string' ? task.description.trim() : '';
  const summary = projectSummary || description || 'Timesheet task';

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

function getSyncLockStateKey(calendarId: string): string {
  return `google-calendar:sync-lock:${calendarId}`;
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
      // Cache miss — a transient pre-load failure shouldn't translate into an
      // empty calendar entry title. Try to fetch the project on demand.
      if (!project) {
        try {
          project = await context.data.getProject(projectId);
          if (project) {
            caches?.projectById?.set(projectId, project as ProjectDto);
          }
        } catch (err) {
          context.logger.warn('Failed to load project for event enrichment', {
            projectId,
            error: String(err)
          });
        }
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

function extractCalendarIdFromResourceUri(resourceUri: string | undefined): string | undefined {
  if (!resourceUri) {
    return undefined;
  }

  try {
    const url = new URL(resourceUri);
    const match = url.pathname.match(/\/calendars\/([^/]+)\/events(?:\/|$)/);
    return match?.[1] ? decodeURIComponent(match[1]) : undefined;
  } catch {
    const match = resourceUri.match(/\/calendars\/([^/]+)\/events(?:[/?#]|$)/);
    return match?.[1] ? decodeURIComponent(match[1]) : undefined;
  }
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
  // Renew well before expiry. The main renewal driver is the daily sync, so the
  // window must comfortably exceed a day — otherwise a once-a-day check almost
  // always misses a tighter window and the watch lapses. 48h gives two daily
  // runs to catch the renewal before the 7-day TTL runs out.
  const renewWindowMs = 48 * 60 * 60 * 1000;

  const mappingsByCalendarId = new Map<string, MappingRecord[]>();
  for (const mapping of projectMappings) {
    if (mapping.externalId) {
      const mappings = mappingsByCalendarId.get(mapping.externalId) ?? [];
      mappings.push(mapping);
      mappingsByCalendarId.set(mapping.externalId, mappings);
    }
  }

  for (const mappings of mappingsByCalendarId.values()) {
    const sortedMappings = [...mappings].sort((left, right) =>
      readWatchExpiration(right.metadata ?? {}) - readWatchExpiration(left.metadata ?? {})
    );
    const mapping = sortedMappings[0];
    const metadata = mapping.metadata ?? {};

    for (const duplicateMapping of sortedMappings.slice(1)) {
      await stopDuplicateWatchChannel(context, client, duplicateMapping);
    }

    const existingExpiration = readMetadataString(metadata, 'watchExpiration');
    if (existingExpiration) {
      const expiresAt = Number(existingExpiration);
      if (expiresAt > now + renewWindowMs) {
        // Watch still has more than the renewal window remaining, skip
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
      // Channel IDs must be unique per registration — Google rejects reuse with
      // `channelIdNotUnique`. A random UUID is unique across renewals and across
      // calendars in the same run, and is matched against the inbound
      // x-goog-channel-id header via stored metadata, so it needn't embed the
      // calendar id. The previous `ts-${installationId}-${externalId}-${now}`
      // form overflowed the 64-char cap and truncated the `-${now}` suffix,
      // yielding a constant id and breaking every renewal after the first.
      const channelId = `ts-${globalThis.crypto.randomUUID()}`;
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

async function stopDuplicateWatchChannel(
  context: IntegrationContext<GoogleCalendarConfig>,
  client: GoogleCalendarClient,
  mapping: MappingRecord
): Promise<void> {
  const metadata = mapping.metadata ?? {};
  const oldChannelId = readMetadataString(metadata, 'watchChannelId');
  const oldResourceId = readMetadataString(metadata, 'watchResourceId');
  if (!oldChannelId || !oldResourceId) {
    return;
  }

  try {
    await client.stopWatch(oldChannelId, oldResourceId);
  } catch (err) {
    context.logger.warn('Failed to stop duplicate watch channel', {
      calendarId: mapping.externalId,
      error: String(err)
    });
    return;
  }

  const updatedMetadata = { ...metadata };
  delete updatedMetadata.watchChannelId;
  delete updatedMetadata.watchResourceId;
  delete updatedMetadata.watchExpiration;

  await context.mappings.upsert({
    system: SYSTEM,
    entity: PROJECT_ENTITY,
    localId: mapping.localId,
    externalId: mapping.externalId,
    externalLabel: mapping.externalLabel,
    metadata: updatedMetadata,
    syncStatus: 'SYNCED'
  });
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

function readWatchExpiration(metadata: Record<string, unknown>): number {
  const expiration = readMetadataString(metadata, 'watchExpiration');
  const value = expiration ? Number(expiration) : 0;
  return Number.isFinite(value) ? value : 0;
}
