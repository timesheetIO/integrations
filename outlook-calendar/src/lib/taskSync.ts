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
  readMetadataString,
  releaseStateLock,
  tryAcquireStateLock
} from '@timesheet/integration-sdk';
import { GraphRequestError, OutlookCalendarClient, TIMESHEET_ID_PROPERTY } from './outlookCalendarClient';
import { formatInZone, isSupportedTimeZone, parseGraphDateTime, toGraphDateTime } from './time';
import {
  OutlookCalendarConfig,
  OutlookCalendarSyncInput,
  OutlookCollection,
  OutlookEvent,
  OutlookNotification,
  OutlookSubscription
} from './types';

const SYSTEM = 'outlook-calendar';
const PROVIDER = 'microsoft';
const PROJECT_ENTITY = 'project';
const TASK_ENTITY = 'task';

const DAY_MS = 24 * 60 * 60 * 1000;
// The change feed covers a fixed window: a year back (the import bound) and a
// year ahead. It restarts once it is a month old so the window keeps moving.
const WINDOW_PAST_MS = 365 * DAY_MS;
const WINDOW_FUTURE_MS = 365 * DAY_MS;
const WINDOW_MAX_AGE_MS = 30 * DAY_MS;
const SYNC_LOCK_TTL_SECONDS = 15 * 60;
const EVENT_IMPORT_LOCK_TTL_SECONDS = 60 * 60;
const MAX_SYNC_ROUNDS = 5;
// Graph keeps event subscriptions for at most 10,080 minutes.
const SUBSCRIPTION_TTL_MS = 10_000 * 60 * 1000;
// Renew well before expiry: the daily maintenance run gets two chances.
const SUBSCRIPTION_RENEW_WINDOW_MS = 48 * 60 * 60 * 1000;
const MAX_LABEL_LENGTH = 255;

// Where the mapped event was created, stored in the task mapping metadata.
// Outlook-originated events keep their own subject (synced with the task
// description); Timesheet-originated events show the project title.
const ORIGIN_OUTLOOK = 'outlook';
const ORIGIN_TIMESHEET = 'timesheet';

// Thrown when Graph no longer accepts the stored feed link.
const FEED_EXPIRED = new Error('outlook-calendar: change feed expired');

const SYNC_LOCK_KEY = 'outlook-calendar:sync-lock';
const SYNC_PENDING_KEY = 'outlook-calendar:sync-pending';
const SUBSCRIPTION_KEY = 'outlook-calendar:subscription';

export interface OutlookCalendarSyncResult {
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
  /** True when the task mapping caches hold the complete list: a miss then means no mapping exists. */
  taskMappingsComplete?: boolean;
}

interface DeltaState {
  deltaLink: string;
  windowStart: string;
  windowEnd: string;
}

interface StoredSubscription {
  id: string;
  expirationDateTime: string;
  clientState: string;
  notificationUrl: string;
}

interface InboundContext {
  client: OutlookCalendarClient;
  caches: SyncBatchCaches;
  timeZone?: string;
}

type Context = IntegrationContext<OutlookCalendarConfig>;

// One client per execution, so the access token is fetched once per run.
const clients = new WeakMap<object, OutlookCalendarClient>();

export function allowsOutbound(context: Context): boolean {
  const direction = context.config?.syncDirection ?? 'bidirectional';
  return direction !== 'outlook-to-timesheet' && direction !== 'external-to-timesheet';
}

export function allowsInbound(context: Context): boolean {
  const direction = context.config?.syncDirection ?? 'bidirectional';
  return direction !== 'timesheet-to-outlook' && direction !== 'timesheet-to-external';
}

export function createClient(context: Context): OutlookCalendarClient {
  let client = clients.get(context);
  if (!client) {
    client = new OutlookCalendarClient({
      getAccessToken: () => context.credentials.getAccessToken(PROVIDER),
      refreshAccessToken: () => context.credentials.refreshToken(PROVIDER)
    });
    clients.set(context, client);
  }
  return client;
}

// ---- Timesheet to Outlook ----------------------------------------------------

export async function syncTaskToOutlook(
  input: OutlookCalendarSyncInput,
  context: Context,
  caches?: SyncBatchCaches
): Promise<OutlookCalendarSyncResult> {
  if (!allowsOutbound(context)) {
    return skipped('sync-direction-mismatch');
  }

  const taskId = input?.taskId || input?.item?.taskId || input?.item?.id;
  if (!taskId) {
    return skipped('missing-task-id');
  }

  const task = await loadTask(taskId, input, context, caches);
  if (!task) {
    return skipped('task-not-found');
  }

  const projectId = task.project?.id ?? (input.item as Record<string, unknown>)?.projectId as string | undefined;
  if (!projectId) {
    return skipped('missing-project');
  }

  const projectMapping = caches?.projectMappingByLocalId
    ? caches.projectMappingByLocalId.get(projectId) ?? null
    : await context.mappings.get({ system: SYSTEM, entity: PROJECT_ENTITY, localId: projectId });
  const calendarId = projectMapping?.externalId;
  if (!calendarId) {
    return { ...skipped('missing-project-mapping'), details: { reason: 'missing-project-mapping', projectId } };
  }

  const client = createClient(context);
  const taskMapping = caches?.taskMappingByLocalId
    ? caches.taskMappingByLocalId.get(task.id) ?? null
    : await context.mappings.get({ system: SYSTEM, entity: TASK_ENTITY, localId: task.id });

  if (task.running) {
    return skipped('task-running');
  }

  if (task.deleted) {
    if (taskMapping?.externalId) {
      await client.deleteEvent(taskMapping.externalId);
      await context.mappings.delete({ system: SYSTEM, entity: TASK_ENTITY, localId: task.id });
      removeTaskMappingFromCaches(caches, taskMapping);
      return { system: SYSTEM, status: 'deleted', syncedCount: 1 };
    }
    return skipped('already-deleted');
  }

  // A relinked event keeps an unknown origin, so only times and location are written to it.
  const storedOrigin = readMappingOrigin(taskMapping);
  const payloadOrigin = taskMapping?.externalId ? storedOrigin : ORIGIN_TIMESHEET;

  let payload: Record<string, unknown>;
  try {
    payload = buildEventPayload(task, payloadOrigin);
  } catch (err) {
    context.logger.warn('Failed to build event payload', { taskId: task.id, error: String(err) });
    return { ...skipped('invalid-task-data'), details: { reason: 'invalid-task-data', taskId: task.id } };
  }

  let event: OutlookEvent;
  let eventWasCreated = false;
  if (taskMapping?.externalId) {
    if (isAlreadySyncedLocalChange(taskMapping.metadata, getLastUpdateMillis(task))) {
      return { ...skipped('already-synced-task-change'), details: { reason: 'already-synced-task-change', taskId: task.id } };
    }
    context.logger.info('Updating event', { taskId: task.id, eventId: taskMapping.externalId });
    event = await client.updateEvent(taskMapping.externalId, payload);
  } else {
    // A stamped event whose mapping was lost (for example after a reinstall).
    // The stamp does not prove a Timesheet origin, so the origin stays unknown.
    const existing = await client.findEventByTimesheetId(task.id);
    if (existing?.id) {
      context.logger.info('Found existing event by timesheetId', { taskId: task.id, eventId: existing.id });
      event = existing;
    } else {
      context.logger.info('Creating event', { taskId: task.id, calendarId });
      event = await client.createEvent(calendarId, payload);
      eventWasCreated = true;
    }
  }

  if (!event?.id) {
    return { system: SYSTEM, status: 'failed', syncedCount: 0, details: { reason: 'missing-external-id' } };
  }

  const mapping: MappingRecord = {
    localId: task.id,
    externalId: event.id,
    externalLabel: label(event.subject ?? task.description ?? task.id),
    metadata: buildTaskMappingMetadata(
      calendarId,
      event,
      getLastUpdateMillis(task),
      storedOrigin ?? (eventWasCreated ? ORIGIN_TIMESHEET : undefined)
    ),
    syncStatus: 'SYNCED'
  };
  await context.mappings.upsert({ system: SYSTEM, entity: TASK_ENTITY, ...mapping });
  putTaskMappingInCaches(caches, mapping);

  return {
    system: SYSTEM,
    status: 'synced',
    syncedCount: 1,
    details: { taskId: task.id, externalTaskId: event.id, calendarId }
  };
}

function buildEventPayload(task: TaskDto, origin?: string): Record<string, unknown> {
  const start = toGraphDateTime(task.startDateTime);
  const end = toGraphDateTime(task.endDateTime);
  if (!start || !end) {
    throw new Error(`Task ${task.id} is missing start or end datetime.`);
  }

  const payload: Record<string, unknown> = { start, end };
  if (task.location) {
    payload.location = { displayName: task.location };
  }
  // The stamp keeps a lost mapping from turning into a duplicate import.
  const stamp = [{ id: TIMESHEET_ID_PROPERTY, value: task.id }];
  const description = typeof task.description === 'string' ? task.description.trim() : '';

  // Outlook-originated events belong to the user: never rename them to the
  // project title and never overwrite their body. The task description
  // round-trips with the subject, mirroring the import.
  if (origin === ORIGIN_OUTLOOK) {
    if (description) {
      payload.subject = label(description);
    }
    payload.singleValueExtendedProperties = stamp;
    return payload;
  }

  // Unknown origin: the event may be the user's own, so only times and location.
  if (origin !== ORIGIN_TIMESHEET) {
    return payload;
  }

  const projectSubject = task.project?.title
    ? [task.project.title, task.project.employer].filter(Boolean).join(' - ')
    : '';
  payload.subject = label(projectSubject || description || 'Timesheet task');
  payload.body = { contentType: 'text', content: task.description ?? '' };
  payload.location = { displayName: task.location ?? '' };
  payload.singleValueExtendedProperties = stamp;
  return payload;
}

async function loadTask(
  taskId: string,
  input: OutlookCalendarSyncInput,
  context: Context,
  caches?: SyncBatchCaches
): Promise<TaskDto | null> {
  // Sync changes carry the task inline with a flat projectId; enrich it with
  // the project instead of a full getTask round-trip.
  if (input?.item && typeof input.item === 'object' && input.item.id) {
    const raw = input.item as Record<string, unknown>;
    const projectId = raw.projectId as string | undefined;
    if (!raw.project && projectId) {
      let project: ProjectDto | undefined = caches?.projectById?.get(projectId);
      if (!project) {
        try {
          project = await context.data.getProject(projectId);
          if (project) {
            caches?.projectById?.set(projectId, project);
          }
        } catch (err) {
          context.logger.warn('Failed to load project for event enrichment', { projectId, error: String(err) });
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

// ---- Outlook to Timesheet ----------------------------------------------------

/**
 * Reads the change feed of every mapped calendar. Runs hold one lock per
 * installation. A run that finds the lock taken leaves a note, and the holder
 * runs one more pass for it, so a change reported mid-sync is not dropped.
 */
export async function runInboundSync(
  context: Context,
  options: { forceFullResync?: boolean; projectMappings?: MappingRecord[] } = {}
): Promise<OutlookCalendarSyncResult> {
  if (!allowsInbound(context)) {
    return skipped('sync-direction-mismatch');
  }

  let inbound: (InboundContext & { calendars: MappingRecord[] }) | undefined;
  let syncedCount = 0;
  let rounds = 0;
  let forceFullResync = !!options.forceFullResync;
  while (rounds < MAX_SYNC_ROUNDS) {
    if (!(await tryAcquireStateLock(context.state, SYNC_LOCK_KEY, SYNC_LOCK_TTL_SECONDS))) {
      await context.state.set(SYNC_PENDING_KEY, Date.now(), { ttlSeconds: SYNC_LOCK_TTL_SECONDS });
      // The holder may have finished in between; take over if the lock is free now.
      if (!(await tryAcquireStateLock(context.state, SYNC_LOCK_KEY, SYNC_LOCK_TTL_SECONDS))) {
        context.logger.info('Outlook sync already in progress, left a note for another pass');
        return { system: SYSTEM, status: 'deferred', syncedCount, details: { reason: 'sync-in-progress' } };
      }
    }
    rounds += 1;
    try {
      await context.state.delete(SYNC_PENDING_KEY);
      inbound ??= await loadInboundContext(context, options.projectMappings);
      if (inbound.calendars.length === 0) {
        return skipped('missing-project-mappings');
      }
      for (const mapping of inbound.calendars) {
        syncedCount += await syncCalendar(context, inbound, mapping, forceFullResync);
      }
    } finally {
      await releaseStateLock(context.state, SYNC_LOCK_KEY);
    }
    forceFullResync = false;
    if (!(await context.state.get(SYNC_PENDING_KEY))) {
      break;
    }
  }

  return {
    system: SYSTEM,
    status: 'completed',
    syncedCount,
    details: { calendarCount: inbound?.calendars.length ?? 0, rounds }
  };
}

async function loadInboundContext(
  context: Context,
  preloadedProjectMappings?: MappingRecord[]
): Promise<InboundContext & { calendars: MappingRecord[] }> {
  const [projectMappings, taskMappings] = await Promise.all([
    preloadedProjectMappings ?? context.mappings.list({ system: SYSTEM, entity: PROJECT_ENTITY }),
    context.mappings.list({ system: SYSTEM, entity: TASK_ENTITY })
  ]);
  // The complete task mapping list makes a cache miss authoritative, which
  // saves a lookup round-trip per event.
  const caches = buildMappingCaches(projectMappings, taskMappings);
  caches.taskMappingsComplete = true;
  const calendars = uniqueCalendars(projectMappings);
  return {
    client: createClient(context),
    caches,
    calendars,
    timeZone: calendars.length > 0 ? await loadUserTimeZone(context) : undefined
  };
}

async function syncCalendar(
  context: Context,
  inbound: InboundContext,
  projectMapping: MappingRecord,
  forceFullResync: boolean
): Promise<number> {
  const calendarId = projectMapping.externalId;
  const stateKey = deltaStateKey(calendarId);
  const stored = forceFullResync ? null : await context.state.get<DeltaState>(stateKey);
  const resume = stored?.deltaLink && !isWindowExpired(stored) ? stored : undefined;

  try {
    return await readChanges(context, inbound, projectMapping, stateKey, resume);
  } catch (err) {
    if (err !== FEED_EXPIRED) {
      throw err;
    }
    // Graph dropped the feed state: start over. Mapped, unchanged events cost no calls.
    context.logger.warn('Outlook change feed expired, starting a new one', { calendarId });
    await context.state.delete(stateKey);
    return await readChanges(context, inbound, projectMapping, stateKey, undefined);
  }
}

async function readChanges(
  context: Context,
  inbound: InboundContext,
  projectMapping: MappingRecord,
  stateKey: string,
  resume: DeltaState | undefined
): Promise<number> {
  const calendarId = projectMapping.externalId;
  const now = Date.now();
  const window = resume
    ? { start: resume.windowStart, end: resume.windowEnd }
    : { start: new Date(now - WINDOW_PAST_MS).toISOString(), end: new Date(now + WINDOW_FUTURE_MS).toISOString() };

  let link = resume?.deltaLink;
  let deltaLink: string | undefined;
  let syncedCount = 0;
  do {
    let page: OutlookCollection<OutlookEvent>;
    try {
      page = await inbound.client.deltaPage(calendarId, link, window);
    } catch (err) {
      if (resume && link === resume.deltaLink && isExpiredDeltaLink(err)) {
        throw FEED_EXPIRED;
      }
      throw err;
    }
    for (const event of page.value ?? []) {
      if (await syncSingleEvent(context, inbound, projectMapping, event)) {
        syncedCount += 1;
      }
    }
    link = page['@odata.nextLink'];
    deltaLink = page['@odata.deltaLink'] ?? deltaLink;
  } while (link);

  if (deltaLink) {
    const state: DeltaState = { deltaLink, windowStart: window.start, windowEnd: window.end };
    await context.state.set(stateKey, state);
  }
  return syncedCount;
}

async function syncSingleEvent(
  context: Context,
  inbound: InboundContext,
  projectMapping: MappingRecord,
  event: OutlookEvent
): Promise<boolean> {
  if (!event?.id || event.type === 'seriesMaster') {
    return false;
  }

  const { client, caches } = inbound;
  const taskMapping = await getTaskMappingByExternalId(context, event.id, caches);

  if (event['@removed']) {
    if (!taskMapping?.localId) {
      return false;
    }
    // The feed also reports events that only left its window: delete the task
    // only when the event is gone or cancelled.
    const current = await client.getEvent(event.id);
    if (current && !current.isCancelled) {
      return false;
    }
    await deleteMappedTask(context, taskMapping, caches);
    return true;
  }

  if (event.isCancelled) {
    if (taskMapping?.localId) {
      await deleteMappedTask(context, taskMapping, caches);
      return true;
    }
    return false;
  }

  if (!taskMapping?.localId) {
    return await importEvent(context, inbound, projectMapping, event);
  }

  const range = toTaskDateRange(event, inbound.timeZone);
  if (!range) {
    return false;
  }

  if (isStaleExternalChange({ metadata: taskMapping.metadata, externalUpdatedAt: event.lastModifiedDateTime })) {
    return false;
  }

  const existing = await context.data.getTask(taskMapping.localId);
  if (isStaleExternalChange({
    externalUpdatedAt: event.lastModifiedDateTime,
    localLastUpdateMillis: getLastUpdateMillis(existing)
  })) {
    return false;
  }

  const storedOrigin = readMappingOrigin(taskMapping);
  const updated = await context.data.updateTask(taskMapping.localId, {
    projectId: projectMapping.localId,
    startDateTime: range.startDateTime,
    endDateTime: range.endDateTime,
    description: getTaskDescriptionFromEvent(event, storedOrigin),
    location: event.location?.displayName || undefined
  } as TaskUpdateInput);

  const mapping: MappingRecord = {
    localId: taskMapping.localId,
    externalId: event.id,
    externalLabel: label(event.subject ?? event.id),
    metadata: buildTaskMappingMetadata(
      projectMapping.externalId,
      event,
      getLastUpdateMillis(updated as TaskDto | undefined) || Date.now(),
      storedOrigin
    ),
    syncStatus: 'SYNCED'
  };
  await context.mappings.upsert({ system: SYSTEM, entity: TASK_ENTITY, ...mapping });
  putTaskMappingInCaches(caches, mapping);
  return true;
}

async function importEvent(
  context: Context,
  inbound: InboundContext,
  projectMapping: MappingRecord,
  listed: OutlookEvent
): Promise<boolean> {
  const calendarId = projectMapping.externalId;
  // Feed items never carry the stamp, so read the event once before importing.
  const event = await inbound.client.getEvent(listed.id);
  if (!event?.id || event.isCancelled) {
    return false;
  }
  // Stamped: created by Timesheet or imported before, and its mapping is gone.
  if (readStamp(event)) {
    return false;
  }
  const range = toTaskDateRange(event, inbound.timeZone);
  if (!range) {
    return false;
  }

  const importLockKey = eventImportLockKey(calendarId, event);
  if (!(await tryAcquireStateLock(context.state, importLockKey, EVENT_IMPORT_LOCK_TTL_SECONDS))) {
    context.logger.info('Outlook event import already in progress, skipping duplicate create', {
      calendarId,
      eventId: event.id
    });
    return false;
  }

  let created: TaskDto;
  try {
    created = await context.data.createTask({
      projectId: projectMapping.localId,
      startDateTime: range.startDateTime,
      endDateTime: range.endDateTime,
      description: getTaskDescriptionFromEvent(event, ORIGIN_OUTLOOK),
      location: event.location?.displayName || undefined
    } as TaskCreateInput);
  } catch (err) {
    // Nothing was created: release the lock so a retry can import the event.
    await releaseStateLock(context.state, importLockKey);
    throw err;
  }

  // Stamp the event with the task id so a reinstall, which loses the mappings,
  // recognizes it as imported. Writing to one occurrence of a series would
  // turn it into an exception, so those stay unstamped. Best-effort: the
  // calendar may be read-only.
  let stamped = event;
  if (event.type !== 'occurrence') {
    try {
      const patched = await inbound.client.updateEvent(event.id, {
        singleValueExtendedProperties: [{ id: TIMESHEET_ID_PROPERTY, value: created.id }]
      });
      // Adopt the post-stamp version only when nothing else changed; otherwise
      // the pending notification must still bring the newer edit in.
      if (patched?.id && eventContentEquals(event, patched)) {
        stamped = patched;
      }
    } catch (err) {
      context.logger.warn('Failed to stamp imported event with timesheetId', {
        calendarId,
        eventId: event.id,
        error: String(err)
      });
    }
  }

  const mapping: MappingRecord = {
    localId: created.id,
    externalId: event.id,
    externalLabel: label(event.subject ?? event.id),
    metadata: buildTaskMappingMetadata(
      calendarId,
      stamped,
      getLastUpdateMillis(created) || Date.now(),
      ORIGIN_OUTLOOK
    ),
    syncStatus: 'SYNCED'
  };
  await context.mappings.upsert({ system: SYSTEM, entity: TASK_ENTITY, ...mapping });
  putTaskMappingInCaches(inbound.caches, mapping);
  return true;
}

async function deleteMappedTask(context: Context, mapping: MappingRecord, caches: SyncBatchCaches): Promise<void> {
  await context.data.deleteTask(mapping.localId);
  await context.mappings.delete({ system: SYSTEM, entity: TASK_ENTITY, localId: mapping.localId });
  removeTaskMappingFromCaches(caches, mapping);
}

async function loadUserTimeZone(context: Context): Promise<string | undefined> {
  try {
    const settings = await context.data.getSettings();
    return isSupportedTimeZone(settings?.timezone) ? settings.timezone : undefined;
  } catch (err) {
    context.logger.warn('Could not read the time zone setting, importing times in UTC', { error: String(err) });
    return undefined;
  }
}

// ---- Change notifications ----------------------------------------------------

/**
 * Graph posts notifications for every change in the user's mailbox. They only
 * tell us that something changed: each accepted batch runs the change feeds
 * of the mapped calendars.
 */
export async function handleOutlookNotifications(
  input: OutlookCalendarSyncInput,
  context: Context
): Promise<OutlookCalendarSyncResult> {
  if (!allowsInbound(context)) {
    return skipped('sync-direction-mismatch');
  }

  const notifications = readNotifications(input?.body);
  if (notifications.length === 0) {
    return { system: SYSTEM, status: 'ignored', syncedCount: 0, details: { reason: 'no-notifications' } };
  }

  const subscription = await context.state.get<StoredSubscription>(SUBSCRIPTION_KEY);
  let accepted = 0;
  const staleSubscriptionIds = new Set<string>();
  for (const notification of notifications) {
    // clientState is the shared secret set on the subscription; anything else is not from Graph.
    if (!subscription || notification.clientState !== subscription.clientState) {
      continue;
    }
    if (notification.subscriptionId !== subscription.id) {
      if (notification.subscriptionId) {
        staleSubscriptionIds.add(notification.subscriptionId);
      }
      continue;
    }
    accepted += 1;
  }

  // Older subscriptions of this installation would each trigger their own runs.
  for (const subscriptionId of staleSubscriptionIds) {
    try {
      await createClient(context).deleteSubscription(subscriptionId);
      context.logger.info('Deleted stale Outlook subscription', { subscriptionId });
    } catch (err) {
      context.logger.warn('Failed to delete stale Outlook subscription', { subscriptionId, error: String(err) });
    }
  }

  if (accepted === 0) {
    return {
      system: SYSTEM,
      status: 'ignored',
      syncedCount: 0,
      details: { reason: staleSubscriptionIds.size > 0 ? 'stale-subscription' : 'unknown-subscription' }
    };
  }

  const result = await runInboundSync(context);
  return { ...result, details: { ...result.details, notifications: accepted } };
}

/**
 * Keeps the installation's mailbox subscription alive: renews it inside the
 * renewal window and creates it when it is missing or Graph lost it.
 */
export async function ensureSubscription(
  context: Context
): Promise<'skipped' | 'current' | 'renewed' | 'created'> {
  const notificationUrl = context.metadata?.webhooks?.['integration-webhook'];
  if (!notificationUrl) {
    context.logger.info('No webhook URL available, skipping the Outlook subscription');
    return 'skipped';
  }

  const stored = await context.state.get<StoredSubscription>(SUBSCRIPTION_KEY);
  const now = Date.now();
  const sameUrl = stored?.notificationUrl === notificationUrl;
  if (stored?.id && sameUrl
      && Date.parse(stored.expirationDateTime) > now + SUBSCRIPTION_RENEW_WINDOW_MS) {
    return 'current';
  }

  const client = createClient(context);
  const expirationDateTime = new Date(now + SUBSCRIPTION_TTL_MS).toISOString();
  // Keep the secret across renewals so notifications of older subscriptions still verify.
  const clientState = stored?.clientState || newClientState();

  if (stored?.id && sameUrl) {
    const renewed = await client.renewSubscription(stored.id, expirationDateTime);
    if (renewed?.id) {
      await context.state.set(SUBSCRIPTION_KEY, {
        ...stored,
        expirationDateTime: renewed.expirationDateTime ?? expirationDateTime
      } satisfies StoredSubscription);
      context.logger.info('Renewed Outlook subscription', { subscriptionId: stored.id });
      return 'renewed';
    }
  } else if (stored?.id) {
    await client.deleteSubscription(stored.id).catch(err =>
      context.logger.warn('Failed to delete Outlook subscription for an old webhook URL', { error: String(err) })
    );
  }

  const input = { notificationUrl, clientState, expirationDateTime };
  let created: OutlookSubscription;
  try {
    created = await client.createSubscription(input);
  } catch (err) {
    if (!(err instanceof GraphRequestError && err.status === 409)) {
      throw err;
    }
    // A leftover subscription for the same URL blocks a new one: remove it and retry once.
    for (const existing of await client.listSubscriptions()) {
      if (existing.notificationUrl === notificationUrl) {
        await client.deleteSubscription(existing.id);
      }
    }
    created = await client.createSubscription(input);
  }

  await context.state.set(SUBSCRIPTION_KEY, {
    id: created.id,
    expirationDateTime: created.expirationDateTime ?? expirationDateTime,
    clientState,
    notificationUrl
  } satisfies StoredSubscription);
  context.logger.info('Created Outlook subscription', { subscriptionId: created.id });
  return 'created';
}

function readNotifications(body: unknown): OutlookNotification[] {
  let parsed = body;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  const value = (parsed as { value?: unknown })?.value;
  return Array.isArray(value)
    ? value.filter((item): item is OutlookNotification => !!item && typeof item === 'object')
    : [];
}

function newClientState(): string {
  return `${globalThis.crypto.randomUUID()}${globalThis.crypto.randomUUID()}`.replace(/-/g, '');
}

// ---- Helpers -------------------------------------------------------------------

export function buildMappingCaches(projectMappings: MappingRecord[], taskMappings: MappingRecord[] = []): SyncBatchCaches {
  const caches: SyncBatchCaches = {
    projectMappingByLocalId: new Map(),
    taskMappingByLocalId: new Map(),
    taskMappingByExternalId: new Map()
  };
  for (const mapping of projectMappings) {
    caches.projectMappingByLocalId!.set(mapping.localId, mapping);
  }
  for (const mapping of taskMappings) {
    putTaskMappingInCaches(caches, mapping);
  }
  return caches;
}

function uniqueCalendars(projectMappings: MappingRecord[]): MappingRecord[] {
  const seen = new Set<string>();
  return projectMappings.filter(mapping => {
    if (!mapping.externalId || seen.has(mapping.externalId)) {
      return false;
    }
    seen.add(mapping.externalId);
    return true;
  });
}

async function getTaskMappingByExternalId(
  context: Context,
  externalId: string,
  caches: SyncBatchCaches
): Promise<MappingRecord | null> {
  if (caches.taskMappingByExternalId?.has(externalId)) {
    return caches.taskMappingByExternalId.get(externalId) ?? null;
  }
  if (caches.taskMappingsComplete) {
    return null;
  }
  const mapping = await context.mappings.findByExternal({ system: SYSTEM, entity: TASK_ENTITY, externalId });
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

function toTaskDateRange(event: OutlookEvent, timeZone?: string): { startDateTime: string; endDateTime: string } | null {
  const start = parseGraphDateTime(event.start);
  const end = parseGraphDateTime(event.end);
  if (start === null || end === null) {
    return null;
  }
  return { startDateTime: formatInZone(start, timeZone), endDateTime: formatInZone(end, timeZone) };
}

function getTaskDescriptionFromEvent(event: OutlookEvent, origin?: string): string {
  // Outlook-originated events keep the task description in the subject.
  // Timesheet-originated events carry the project title there and the task
  // description in the body; reading the subject back would overwrite it.
  if (origin === ORIGIN_OUTLOOK) {
    return event.subject?.trim() || bodyText(event);
  }
  return bodyText(event);
}

function bodyText(event: OutlookEvent): string {
  return (event.body?.content ?? '').replace(/\r\n/g, '\n').trim();
}

function readStamp(event: OutlookEvent): string | undefined {
  return event.singleValueExtendedProperties
    ?.find(property => property.id?.toLowerCase() === TIMESHEET_ID_PROPERTY.toLowerCase())
    ?.value || undefined;
}

function eventContentEquals(a: OutlookEvent, b: OutlookEvent): boolean {
  return (a.subject ?? '') === (b.subject ?? '')
    && (a.location?.displayName ?? '') === (b.location?.displayName ?? '')
    && !!a.isCancelled === !!b.isCancelled
    && parseGraphDateTime(a.start) === parseGraphDateTime(b.start)
    && parseGraphDateTime(a.end) === parseGraphDateTime(b.end);
}

function buildTaskMappingMetadata(
  calendarId: string,
  event: OutlookEvent,
  timesheetUpdatedAt?: number,
  origin?: string
): Record<string, string> {
  return {
    calendarId,
    changeKey: event.changeKey ?? '',
    updated: event.lastModifiedDateTime ?? '',
    timesheetUpdatedAt: timesheetUpdatedAt && Number.isFinite(timesheetUpdatedAt)
      ? String(Math.floor(timesheetUpdatedAt))
      : '',
    origin: origin ?? ''
  };
}

function readMappingOrigin(mapping: MappingRecord | null | undefined): string | undefined {
  return mapping ? readMetadataString(mapping.metadata ?? {}, 'origin') : undefined;
}

function isWindowExpired(state: DeltaState): boolean {
  const start = Date.parse(state.windowStart);
  return !Number.isFinite(start) || start < Date.now() - WINDOW_PAST_MS - WINDOW_MAX_AGE_MS;
}

function isExpiredDeltaLink(err: unknown): boolean {
  if (!(err instanceof GraphRequestError)) {
    return false;
  }
  return err.status === 410
    || /syncstate|resync/i.test(err.code ?? '')
    || err.status === 400
    || err.status === 404;
}

function label(value: string): string {
  return value.length > MAX_LABEL_LENGTH ? value.slice(0, MAX_LABEL_LENGTH) : value;
}

function skipped(reason: string): OutlookCalendarSyncResult {
  return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason } };
}

// Graph ids are long; state keys are capped at 255 characters.
function deltaStateKey(calendarId: string): string {
  return `outlook-calendar:delta:${stableHash(calendarId)}`;
}

function eventImportLockKey(calendarId: string, event: OutlookEvent): string {
  const version = event.lastModifiedDateTime ?? event.changeKey ?? 'unknown';
  return `outlook-calendar:event-import:${stableHash(`${calendarId}:${event.id}:${version}`)}`;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
