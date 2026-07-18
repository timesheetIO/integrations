import {
  IntegrationContext,
  MappingRecord,
  ProjectDto,
  TaskCreateInput,
  TaskDto,
  TaskUpdateInput,
  getLastUpdateMillis,
  isAlreadySyncedLocalChange,
  isStaleExternalChange,
  readMetadataNumber,
  readMetadataString,
  releaseStateLock,
  tryAcquireStateLock
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
// Imports are bounded client-side, NOT via timeMin/updatedMin request params:
// Google omits nextSyncToken from filtered listings, which permanently breaks
// incremental sync (every webhook then loops through the expired-token path).
const IMPORT_CUTOFF_MS = 365 * 24 * 60 * 60 * 1000;
const EVENT_IMPORT_LOCK_TTL_SECONDS = 60 * 60;
// Where the mapped event was created. Google-originated events keep their own
// title (synced with the task description); Timesheet-originated events show
// the project title. Stored in the task mapping metadata as `origin`.
const ORIGIN_GOOGLE = 'google';
const ORIGIN_TIMESHEET = 'timesheet';

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
  /** True when the task mapping caches hold the complete list — a miss then means no mapping exists. */
  taskMappingsComplete?: boolean;
}

interface SyncCalendarOptions {
  caches?: SyncBatchCaches;
  lockTtlSeconds?: number;
  /** Ignore the stored sync token and run the token-restoring full listing. */
  forceFullResync?: boolean;
}

interface FetchAndSyncOptions {
  importLockTtlSeconds?: number;
}

interface FullSyncOptions {
  lockTtlSeconds?: number;
  forceFullResync?: boolean;
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

  // Events created by Timesheet carry the project title as summary; events
  // created in Google keep their own title (synced with the task description).
  const storedOrigin = readMappingOrigin(taskMapping);
  const payloadOrigin = taskMapping?.externalId ? storedOrigin : ORIGIN_TIMESHEET;

  let payload: Record<string, unknown>;
  try {
    payload = buildGoogleEventPayload(task, payloadOrigin);
  } catch (err) {
    context.logger.warn('Failed to build event payload', { taskId: task.id, error: String(err) });
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'invalid-task-data', taskId: task.id } };
  }
  let externalEvent: GoogleCalendarEvent;
  let eventWasCreated = false;

  if (taskMapping?.externalId) {
    if (isAlreadySyncedLocalChange(taskMapping.metadata, getLastUpdateMillis(task))) {
      return {
        system: SYSTEM,
        status: 'skipped',
        syncedCount: 0,
        details: { reason: 'already-synced-task-change', taskId: task.id }
      };
    }

    const mappedCalendarId = getMappedCalendarId(taskMapping) ?? externalCalendarId;
    context.logger.info('Updating event', { taskId: task.id, calendarId: mappedCalendarId, eventId: taskMapping.externalId });
    externalEvent = await client.updateEvent(mappedCalendarId, taskMapping.externalId, payload);
  } else {
    const duplicate = await findEventByTimesheetId(client, externalCalendarId, task.id);
    if (duplicate?.id) {
      // Relinking a stamped event whose mapping was lost (e.g. reinstall). The
      // stamp does not prove a Timesheet origin — back-synced imports carry it
      // too — so the origin stays unknown and updates remain conservative.
      context.logger.info('Found existing event by timesheetId', { taskId: task.id, eventId: duplicate.id });
      externalEvent = duplicate;
    } else {
      context.logger.info('Creating event', { taskId: task.id, calendarId: externalCalendarId, summary: payload.summary });
      externalEvent = await client.createEvent(externalCalendarId, payload);
      eventWasCreated = true;
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

  // Backfill the origin for legacy mappings when provable: Timesheet-created
  // events always carry the timesheetId stamp, so its absence proves the event
  // was created in Google. Presence is ambiguous (old echoes stamped imported
  // events too), so those stay unknown. Only an event we created right now is
  // certainly Timesheet-originated — a relinked stamped event is not.
  const mappingOrigin = storedOrigin
    ?? (eventWasCreated ? ORIGIN_TIMESHEET : inferOriginFromEvent(externalEvent));

  const upsertedMapping: MappingRecord = {
    localId: task.id,
    externalId: externalEvent.id,
    externalLabel: externalEvent.summary ?? task.description ?? task.id,
    metadata: buildTaskMappingMetadata(externalCalendarId, externalEvent, getLastUpdateMillis(task), mappingOrigin),
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

  // Preload the complete task mapping list once. Without it, every event in a
  // full resync falls through to a per-event findByExternal round-trip
  // (~1.3s of flat api.timesheet.io latency each), so a calendar with a few
  // hundred events exhausts the 15-minute execution budget before any work is
  // done. With the cache, already-mapped events cost no API calls — this is the
  // same preload handleGoogleWebhook does.
  const [projectMappings, allTaskMappings] = await Promise.all([
    context.mappings.list({ system: SYSTEM, entity: PROJECT_ENTITY }),
    context.mappings.list({ system: SYSTEM, entity: TASK_ENTITY })
  ]);
  if (projectMappings.length === 0) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'missing-project-mappings' } };
  }
  const caches = buildMappingCaches(projectMappings, allTaskMappings);
  caches.taskMappingsComplete = true;

  let syncedCount = 0;
  if (allowInbound) {
    for (const mapping of projectMappings) {
      if (!mapping.externalId) {
        continue;
      }

      const perCalendarCount = await syncCalendar(context, mapping, {
        caches,
        lockTtlSeconds: options.lockTtlSeconds,
        forceFullResync: options.forceFullResync
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
  const resourceId = getHeader(input, 'x-goog-resource-id');
  const resourceUri = getHeader(input, 'x-goog-resource-uri');
  const resourceCalendarId = extractCalendarIdFromResourceUri(resourceUri);
  // Preload the complete task mapping list once — the per-event findByExternal
  // round-trips otherwise dominate the webhook execution time.
  const [allProjectMappings, allTaskMappings] = await Promise.all([
    context.mappings.list({ system: SYSTEM, entity: PROJECT_ENTITY }),
    context.mappings.list({ system: SYSTEM, entity: TASK_ENTITY })
  ]);
  const caches = buildMappingCaches(allProjectMappings, allTaskMappings);
  caches.taskMappingsComplete = true;

  let projectMappings = allProjectMappings;
  if (channelId) {
    // Resolve the calendar this notification belongs to: the mapping that
    // stores this channel id, or the calendar named in the notification.
    const channelMapping = allProjectMappings.find((mapping) => readWatchChannelId(mapping) === channelId);
    const calendarId = channelMapping?.externalId ?? input.calendarId ?? resourceCalendarId;
    const calendarMappings = calendarId
      ? allProjectMappings.filter((mapping) => mapping.externalId === calendarId)
      : [];

    // Exactly one channel per calendar is canonical — the one stored on the
    // mapping ensureWatchChannels maintains (newest watchExpiration). Several
    // historical channels on the same calendar each deliver a notification per
    // change; accepting them all processes every change several times over.
    const canonicalMapping = [...calendarMappings].sort((left, right) =>
      readWatchExpiration(right.metadata ?? {}) - readWatchExpiration(left.metadata ?? {})
    )[0];
    const canonicalChannelId = canonicalMapping ? readWatchChannelId(canonicalMapping) : undefined;

    if (canonicalChannelId && canonicalChannelId !== channelId) {
      context.logger.info('Ignoring stale Google Calendar watch notification', {
        channelId,
        resourceCalendarId: calendarId ?? ''
      });
      await stopStaleWatchChannel(context, channelId, resourceId);
      return {
        system: SYSTEM,
        status: 'ignored',
        syncedCount: 0,
        details: { reason: 'stale-watch-channel', channelId, resourceCalendarId: calendarId ?? '' }
      };
    }

    projectMappings = canonicalMapping ? [canonicalMapping] : calendarMappings;
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
  for (const mapping of projectMappings) {
    if (!mapping.externalId || seenCalendarIds.has(mapping.externalId)) {
      continue;
    }
    seenCalendarIds.add(mapping.externalId);
    syncedCount += await syncCalendar(context, mapping, {
      caches,
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
    if (!(await tryAcquireStateLock(context.state, lockKey, options.lockTtlSeconds))) {
      context.logger.info('Calendar sync already in progress, skipping duplicate webhook', { calendarId });
      return 0;
    }
    acquiredLock = true;
  }

  const syncStateKey = getSyncTokenStateKey(calendarId);
  try {
    // Note: legacy plugin versions stored a syncToken in the project mapping
    // metadata. It is never refreshed and therefore permanently expired —
    // falling back to it guaranteed a 410 round-trip on every sync.
    const syncToken = options.forceFullResync
      ? undefined
      : (await context.state.get<string>(syncStateKey)) ?? undefined;

    try {
      return await fetchAndSyncEvents(
        context,
        client,
        projectMapping,
        calendarId,
        syncStateKey,
        syncToken,
        options.caches,
        {
          importLockTtlSeconds: options.lockTtlSeconds ? EVENT_IMPORT_LOCK_TTL_SECONDS : undefined
        }
      );
    } catch (err) {
      // Google returns 400 or 410 when a sync token is invalid/expired. Run
      // the token-restoring full listing — with the preloaded mapping caches,
      // mapped/unchanged events cost no API calls, so this is a few page
      // fetches plus imports of genuinely missing events.
      const errMsg = String(err);
      if (syncToken && (errMsg.includes('(410)') || errMsg.includes('Invalid sync token'))) {
        context.logger.warn('Sync token expired, performing full resync to restore it', { calendarId });
        await context.state.delete(syncStateKey);
        return await fetchAndSyncEvents(
          context,
          client,
          projectMapping,
          calendarId,
          syncStateKey,
          undefined,
          options.caches,
          {
            importLockTtlSeconds: options.lockTtlSeconds ? EVENT_IMPORT_LOCK_TTL_SECONDS : undefined
          }
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

  // The token-restoring full listing must not use timeMin/updatedMin — Google
  // omits nextSyncToken from filtered listings. Old events are bounded
  // client-side instead: events that ended before the cutoff are not imported.
  const importCutoffMs = syncToken ? undefined : Date.now() - IMPORT_CUTOFF_MS;

  do {
    const response = await client.listEvents(calendarId, {
      showDeleted: true,
      singleEvents: true,
      syncToken,
      pageToken
    });

    for (const event of response.items ?? []) {
      const synced = await syncSingleGoogleEvent(context, client, projectMapping, calendarId, event, caches, {
        importLockTtlSeconds: options.importLockTtlSeconds,
        importCutoffMs
      });
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
  client: GoogleCalendarClient,
  projectMapping: MappingRecord,
  calendarId: string,
  event: GoogleCalendarEvent,
  caches?: SyncBatchCaches,
  options: { importLockTtlSeconds?: number; importCutoffMs?: number } = {}
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

    // Client-side import bound for the unfiltered token-restoring listing —
    // don't create tasks for long-past events. Mapped events above still
    // process updates regardless of age.
    if (options.importCutoffMs) {
      const endMs = Date.parse(dateRange.endDateTime);
      if (Number.isFinite(endMs) && endMs < options.importCutoffMs) {
        return false;
      }
    }

    let importLockKey: string | undefined;
    if (options.importLockTtlSeconds && options.importLockTtlSeconds > 0) {
      importLockKey = getEventImportLockStateKey(calendarId, event);
      if (!(await tryAcquireStateLock(context.state, importLockKey, options.importLockTtlSeconds))) {
        context.logger.info('Google Calendar event import already in progress, skipping duplicate create', {
          calendarId,
          eventId: event.id,
          updated: event.updated ?? ''
        });
        return false;
      }
    }

    let created;
    try {
      created = await context.data.createTask({
        projectId: projectMapping.localId,
        startDateTime: dateRange.startDateTime,
        endDateTime: dateRange.endDateTime,
        description: getTaskDescriptionFromEvent(event, ORIGIN_GOOGLE),
        location: event.location
      } as TaskCreateInput);
    } catch (err) {
      // No task was created — release the lock so a webhook retry can import
      // the event. Otherwise the retry skips it as a duplicate, the sync token
      // advances past it, and the event is lost until it is edited again.
      if (importLockKey) {
        await releaseStateLock(context.state, importLockKey);
      }
      throw err;
    }
    // Stamp the event with the task id so a future reinstall (which loses the
    // mappings) recognizes it as already imported instead of duplicating the
    // task. PATCH merges the key into the private map without touching any
    // other field. Best-effort: an import-only calendar may be read-only.
    let stampedEvent = event;
    try {
      const patched = await client.updateEvent(calendarId, event.id, {
        extendedProperties: {
          private: {
            timesheetId: created.id
          }
        }
      });
      // Only adopt the post-stamp `updated` when nothing else changed. If the
      // event was edited in Google between the list fetch and the stamp, the
      // task was built from stale data — keep the listed `updated` so the
      // pending webhook re-processes the event instead of self-skipping.
      if (patched?.id && eventContentEquals(event, patched)) {
        stampedEvent = patched;
      }
    } catch (err) {
      context.logger.warn('Failed to stamp imported event with timesheetId', {
        calendarId,
        eventId: event.id,
        error: String(err)
      });
    }

    const createdTask = created as TaskDto;
    const timesheetUpdatedAt = getLastUpdateMillis(createdTask) || Date.now();
    // Metadata comes from the stamped event so the webhook fired by our own
    // PATCH carries the same `updated` value and self-skips.
    const metadata = buildTaskMappingMetadata(calendarId, stampedEvent, timesheetUpdatedAt, ORIGIN_GOOGLE);

    await context.mappings.upsert({
      system: SYSTEM,
      entity: TASK_ENTITY,
      localId: created.id,
      externalId: event.id,
      externalLabel: stampedEvent.summary ?? event.summary ?? event.id,
      metadata,
      syncStatus: 'SYNCED'
    });
    putTaskMappingInCaches(caches, {
      localId: created.id,
      externalId: event.id,
      externalLabel: stampedEvent.summary ?? event.summary ?? event.id,
      metadata,
      syncStatus: 'SYNCED'
    });

    return true;
  }

  if (isStaleExternalChange({ metadata: taskMapping.metadata, externalUpdatedAt: event.updated })) {
    return false;
  }

  const existing = await context.data.getTask(taskMapping.localId);
  if (isStaleExternalChange({
    externalUpdatedAt: event.updated,
    localLastUpdateMillis: getLastUpdateMillis(existing)
  })) {
    return false;
  }

  const storedOrigin = readMappingOrigin(taskMapping);
  const updated = await context.data.updateTask(taskMapping.localId, {
    projectId: projectMapping.localId,
    startDateTime: dateRange.startDateTime,
    endDateTime: dateRange.endDateTime,
    description: getTaskDescriptionFromEvent(event, storedOrigin),
    location: event.location
  } as TaskUpdateInput);
  const updatedTask = updated as TaskDto | undefined;
  const timesheetUpdatedAt = getLastUpdateMillis(updatedTask) || Date.now();
  const metadata = buildTaskMappingMetadata(calendarId, event, timesheetUpdatedAt, storedOrigin ?? inferOriginFromEvent(event));

  await context.mappings.upsert({
    system: SYSTEM,
    entity: TASK_ENTITY,
    localId: taskMapping.localId,
    externalId: event.id,
    externalLabel: event.summary ?? event.id,
    metadata,
    syncStatus: 'SYNCED'
  });
  putTaskMappingInCaches(caches, {
    localId: taskMapping.localId,
    externalId: event.id,
    externalLabel: event.summary ?? event.id,
    metadata,
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

  // The webhook path preloads the complete task mapping list — a miss means
  // no mapping exists, so skip the per-event lookup round-trip.
  if (caches?.taskMappingsComplete) {
    return null;
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

function buildGoogleEventPayload(task: TaskDto, origin?: string): Record<string, unknown> {
  const startDateTime = task.startDateTime;
  const endDateTime = task.endDateTime;

  if (!startDateTime || !endDateTime) {
    throw new Error(`Task ${task.id} is missing start or end datetime.`);
  }

  const payload: Record<string, unknown> = {
    start: {
      dateTime: startDateTime
    },
    end: {
      dateTime: endDateTime
    }
  };
  if (task.location) {
    payload.location = task.location;
  }

  // Google-originated events belong to the user: never rename them to the
  // project title and never overwrite their body. The task description
  // round-trips with the event title (summary), mirroring the import mapping.
  if (origin === ORIGIN_GOOGLE) {
    const description = typeof task.description === 'string' ? task.description.trim() : '';
    if (description) {
      payload.summary = description;
    }
    // Keep the timesheetId check field on the event — it prevents duplicate
    // imports when mappings are lost (e.g. reinstall). Harmless for the text
    // mapping since the stored origin decides it, not the stamp.
    payload.extendedProperties = {
      private: {
        timesheetId: task.id
      }
    };
    return payload;
  }

  // Unknown origin (mappings predating the origin marker): the event may be
  // user-created, so writing texts risks destroying it. Only sync times and
  // location.
  if (origin !== ORIGIN_TIMESHEET) {
    return payload;
  }

  const projectSummary = task.project?.title
    ? [task.project.title, task.project.employer].filter(Boolean).join(' - ')
    : '';
  const description = typeof task.description === 'string' ? task.description.trim() : '';

  const creatorEmail = task.member?.email;
  const creatorDisplayName = task.member?.displayName;

  payload.summary = projectSummary || description || 'Timesheet task';
  payload.location = task.location ?? null;
  payload.description = task.description ?? '';
  payload.extendedProperties = {
    private: {
      timesheetId: task.id
    }
  };
  if (creatorEmail) {
    payload.creator = {
      email: creatorEmail,
      displayName: creatorDisplayName
    };
  }
  return payload;
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

function readWatchChannelId(mapping: MappingRecord): string | undefined {
  const metadata = mapping.metadata ?? {};
  return readMetadataString(metadata, 'watchChannelId')
    || readMetadataString(metadata, 'channelId');
}

async function stopStaleWatchChannel(
  context: IntegrationContext<GoogleCalendarConfig>,
  channelId: string,
  resourceId: string | undefined
): Promise<void> {
  if (!resourceId) {
    return;
  }
  try {
    const client = createClient(context);
    await client.stopWatch(channelId, resourceId);
    context.logger.info('Stopped stale Google Calendar watch channel', { channelId });
  } catch (err) {
    context.logger.warn('Failed to stop stale watch channel', { channelId, error: String(err) });
  }
}

function buildTaskMappingMetadata(
  calendarId: string,
  event: GoogleCalendarEvent,
  timesheetUpdatedAt?: number,
  origin?: string
): Record<string, string> {
  return {
    calendarId,
    etag: event.etag ?? '',
    updated: event.updated ?? '',
    timesheetUpdatedAt: timesheetUpdatedAt && Number.isFinite(timesheetUpdatedAt)
      ? String(Math.floor(timesheetUpdatedAt))
      : '',
    origin: origin ?? ''
  };
}

function readMappingOrigin(mapping: MappingRecord | null | undefined): string | undefined {
  if (!mapping) {
    return undefined;
  }
  return readMetadataString(mapping.metadata ?? {}, 'origin');
}

function eventContentEquals(a: GoogleCalendarEvent, b: GoogleCalendarEvent): boolean {
  return (a.summary ?? '') === (b.summary ?? '')
    && (a.description ?? '') === (b.description ?? '')
    && (a.location ?? '') === (b.location ?? '')
    && (a.status ?? '') === (b.status ?? '')
    && (a.start?.dateTime ?? a.start?.date ?? '') === (b.start?.dateTime ?? b.start?.date ?? '')
    && (a.end?.dateTime ?? a.end?.date ?? '') === (b.end?.dateTime ?? b.end?.date ?? '');
}

function inferOriginFromEvent(event: GoogleCalendarEvent | undefined): string | undefined {
  // Timesheet-created events always carry the timesheetId stamp, so its
  // absence proves a Google origin. Presence is ambiguous — old echoes
  // stamped imported events too — so those stay unknown.
  return event?.extendedProperties?.private?.timesheetId ? undefined : ORIGIN_GOOGLE;
}

function getTaskDescriptionFromEvent(event: GoogleCalendarEvent, origin?: string): string {
  // Google-originated events keep the task description in the event title
  // (summary). The timesheetId stamp is not reliable for them: old echoes
  // stamped imported events too, so the stored mapping origin wins.
  if (origin === ORIGIN_GOOGLE) {
    const summary = event.summary?.trim();
    return summary || event.description || '';
  }
  // Timesheet-originated events carry the project title in the summary and the
  // task description in the description — mapping the summary back would
  // overwrite the task description with the project title.
  if (origin === ORIGIN_TIMESHEET || event.extendedProperties?.private?.timesheetId) {
    return event.description ?? '';
  }
  const summary = event.summary?.trim();
  if (summary) {
    return summary;
  }
  return event.description ?? '';
}

function getSyncTokenStateKey(calendarId: string): string {
  return `google-calendar:sync-token:${calendarId}`;
}

function getSyncLockStateKey(calendarId: string): string {
  return `google-calendar:sync-lock:${calendarId}`;
}

function getEventImportLockStateKey(calendarId: string, event: GoogleCalendarEvent): string {
  const version = event.updated ?? event.etag ?? 'unknown';
  return `google-calendar:event-import:${stableHash(`${calendarId}:${event.id}:${version}`)}`;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
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

function readWatchExpiration(metadata: Record<string, unknown>): number {
  const expiration = readMetadataString(metadata, 'watchExpiration');
  const value = expiration ? Number(expiration) : 0;
  return Number.isFinite(value) ? value : 0;
}
