import {
  IntegrationContext,
  MappingRecord,
  TaskCreateInput,
  TaskDto,
  TaskUpdateInput,
  getLastUpdateMillis,
  isAlreadySyncedLocalChange,
  releaseStateLock,
  syncMetadataStamp,
  tryAcquireStateLock
} from '@timesheet/integration-sdk';
import { FreshBooksClient } from './freshbooksClient';
import {
  FreshBooksConfig,
  FreshBooksTimeEntry,
  FreshBooksWebhookPayload,
  SyncInput
} from './types';

const SYSTEM = 'freshbooks';
const PROJECT_ENTITY = 'project';
const USER_ENTITY = 'user';
const TASK_ENTITY = 'task';
const RATE_ENTITY = 'rate';
const SYNC_STATE_KEY = 'freshbooks:last-sync-time';
const WEBHOOK_STATE_KEY = 'freshbooks:webhook';
// Import locks close the webhook-vs-full-sync race on first import; held for
// the TTL (not released on success) so duplicate deliveries stay suppressed
// until the new mapping is visible everywhere.
const IMPORT_LOCK_TTL_SECONDS = 60 * 60;

export interface FreshBooksSyncResult {
  system: string;
  status: string;
  syncedCount: number;
  details?: Record<string, unknown>;
}

export interface SyncBatchCaches {
  projectMappingByLocalId?: Map<string, MappingRecord>;
  userMappingByLocalId?: Map<string, MappingRecord>;
  taskMappingByLocalId?: Map<string, MappingRecord>;
  rateMappingByLocalId?: Map<string, MappingRecord>;
}

interface StoredWebhookState {
  callbackId: string;
  verifier: string;
  uri?: string;
}

interface DesiredTaskFields {
  projectId: string;
  userId: string;
  startDateTime: string;
  endDateTime: string;
  description: string;
  billable: boolean;
  rateId?: string;
}

let sharedClient: FreshBooksClient | null = null;

export function resetSharedClient(): void {
  sharedClient = null;
}

export function createFreshBooksClient(context: IntegrationContext<FreshBooksConfig>): FreshBooksClient {
  return new FreshBooksClient({
    getAccessToken: () => context.credentials.getAccessToken(SYSTEM),
    refreshAccessToken: () => context.credentials.refreshToken(SYSTEM),
    businessId: context.config?.businessId
  });
}

function getOrCreateClient(context: IntegrationContext<FreshBooksConfig>): FreshBooksClient {
  if (!sharedClient) {
    sharedClient = createFreshBooksClient(context);
  }
  return sharedClient;
}

// ============================================================================
// Outbound: Timesheet task  →  FreshBooks time entry
// ============================================================================

export async function syncTaskToFreshBooks(
  input: SyncInput,
  context: IntegrationContext<FreshBooksConfig>,
  caches?: SyncBatchCaches
): Promise<FreshBooksSyncResult> {
  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  if (syncDirection === 'freshbooks-to-timesheet' || syncDirection === 'external-to-timesheet') {
    return skip({ reason: 'sync-direction-mismatch' });
  }

  const taskId = resolveTaskId(input);
  if (!taskId) {
    return skip({ reason: 'missing-task-id' });
  }

  const task = await loadTask(taskId, input, context);
  if (!task) {
    return skip({ reason: 'task-not-found', taskId });
  }

  if (task.running) {
    return skip({ reason: 'task-running', taskId });
  }

  const client = getOrCreateClient(context);
  const taskMapping = await getMapping(context, caches?.taskMappingByLocalId, TASK_ENTITY, task.id);

  // A delete only needs the task mapping — external project/user mappings may
  // not resolve from a minimal delete payload, and aren't needed to remove the
  // external entry.
  if (task.deleted) {
    if (taskMapping?.externalId) {
      try {
        await client.deleteTimeEntry(taskMapping.externalId);
      } catch (err) {
        // A 404 means it's already gone in FreshBooks — treat as deleted.
        if (!String(err).includes('(404)')) {
          throw err;
        }
      }
      await context.mappings.delete({ system: SYSTEM, entity: TASK_ENTITY, localId: task.id });
      caches?.taskMappingByLocalId?.delete(task.id);
      return { system: SYSTEM, status: 'deleted', syncedCount: 1 };
    }
    return skip({ reason: 'already-deleted' });
  }

  // Echo guard: a change not newer than our own last write for this task is
  // the event fired by that write — syncing it out would ping-pong forever.
  if (taskMapping?.externalId
      && isAlreadySyncedLocalChange(taskMapping.metadata, getLastUpdateMillis(task))) {
    return skip({ reason: 'already-synced-task-change', taskId: task.id });
  }

  const projectId = task.project?.id;
  if (!projectId) {
    return skip({ reason: 'missing-project', taskId });
  }

  const projectMapping = await getMapping(context, caches?.projectMappingByLocalId, PROJECT_ENTITY, projectId);
  if (!projectMapping?.externalId) {
    return skip({ reason: 'missing-project-mapping', projectId });
  }

  const localUserId = task.user ?? task.member?.uid;
  if (!localUserId) {
    return skip({ reason: 'missing-user', taskId });
  }

  const userMapping = await getMapping(context, caches?.userMappingByLocalId, USER_ENTITY, localUserId);
  if (!userMapping?.externalId) {
    return skip({ reason: 'missing-user-mapping', userId: localUserId });
  }

  const durationSeconds = computeDurationSeconds(task);
  if (durationSeconds == null) {
    return skip({ reason: 'invalid-task-duration', taskId: task.id });
  }
  if (durationSeconds <= 0) {
    return skip({ reason: 'zero-duration', taskId: task.id });
  }

  const startedAt = toStartedAt(task.startDateTime);
  if (!startedAt) {
    return skip({ reason: 'invalid-start-date', taskId: task.id });
  }

  const rateId = task.rate?.id;
  const rateMapping = rateId
    ? await getMapping(context, caches?.rateMappingByLocalId, RATE_ENTITY, rateId)
    : null;

  // The time entry needs the client id; the mapping caches it after the first
  // resolve, otherwise ask FreshBooks for the project's client.
  const clientId = await resolveClientId(client, projectMapping, task.id, context);

  const payload = buildTimeEntryPayload({
    projectExternalId: projectMapping.externalId,
    userExternalId: userMapping.externalId,
    clientId,
    serviceExternalId: rateMapping?.externalId,
    durationSeconds,
    startedAt,
    note: task.description ?? '',
    billable: task.billable ?? false
  });

  let external: FreshBooksTimeEntry;
  if (taskMapping?.externalId) {
    const existing = await client.getTimeEntry(taskMapping.externalId);
    if (existing?.id) {
      external = await client.updateTimeEntry(String(existing.id), payload);
    } else {
      external = await client.createTimeEntry(payload);
    }
  } else {
    external = await client.createTimeEntry(payload);
  }

  const upserted: MappingRecord = {
    localId: task.id,
    externalId: String(external.id),
    externalLabel: task.description ?? task.id,
    metadata: buildTaskMappingMetadata({
      projectId: projectMapping.externalId,
      identityId: userMapping.externalId,
      serviceId: rateMapping?.externalId,
      clientId: clientId != null ? String(clientId) : undefined,
      localLastUpdateMillis: getLastUpdateMillis(task)
    }),
    syncStatus: 'SYNCED'
  };

  await context.mappings.upsert({ system: SYSTEM, entity: TASK_ENTITY, ...upserted });
  caches?.taskMappingByLocalId?.set(task.id, upserted);

  return {
    system: SYSTEM,
    status: 'synced',
    syncedCount: 1,
    details: { taskId: task.id, externalTaskId: String(external.id) }
  };
}

// ============================================================================
// Inbound: FreshBooks  →  Timesheet (full sync + webhook handler)
// ============================================================================

export async function runFreshBooksFullSync(
  context: IntegrationContext<FreshBooksConfig>
): Promise<FreshBooksSyncResult> {
  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  const allowInbound = syncDirection !== 'timesheet-to-freshbooks' && syncDirection !== 'timesheet-to-external';

  const projectMappings = await context.mappings.list({ system: SYSTEM, entity: PROJECT_ENTITY });
  const userMappings = await context.mappings.list({ system: SYSTEM, entity: USER_ENTITY });

  if (projectMappings.length === 0 || userMappings.length === 0) {
    return skip({
      reason: projectMappings.length === 0 ? 'missing-project-mappings' : 'missing-user-mappings'
    });
  }

  if (!allowInbound) {
    return {
      system: SYSTEM,
      status: 'completed',
      syncedCount: 0,
      details: { syncDirection, reason: 'outbound-only' }
    };
  }

  const rateMappings = await context.mappings.list({ system: SYSTEM, entity: RATE_ENTITY });
  const projectByExternalId = new Map(projectMappings.map((mapping) => [mapping.externalId, mapping.localId]));
  const userByExternalId = new Map(userMappings.map((mapping) => [mapping.externalId, mapping.localId]));
  const rateByExternalId = new Map(rateMappings.map((mapping) => [mapping.externalId, mapping.localId]));

  const lastSyncTime = (await context.state.get<string>(SYNC_STATE_KEY)) ?? undefined;
  const startedAt = new Date().toISOString();

  const client = getOrCreateClient(context);
  const entries = await client.listTimeEntries({ updatedSinceIso: lastSyncTime });

  let syncedCount = 0;
  for (const entry of entries) {
    const synced = await syncSingleExternalEntry(
      entry,
      context,
      projectByExternalId,
      userByExternalId,
      rateByExternalId
    );
    if (synced) {
      syncedCount += 1;
    }
  }

  await context.state.set(SYNC_STATE_KEY, startedAt);

  return {
    system: SYSTEM,
    status: 'completed',
    syncedCount,
    details: { syncDirection, sinceIso: lastSyncTime ?? null, entryCount: entries.length }
  };
}

export async function handleFreshBooksWebhook(
  input: SyncInput,
  context: IntegrationContext<FreshBooksConfig>
): Promise<FreshBooksSyncResult> {
  const payload = parseWebhookPayload(input.body, getRawBody(input));

  // Verification handshake: on callback creation FreshBooks POSTs a `verifier`
  // to the callback URL. Persist it (it becomes the HMAC secret) and confirm
  // ownership by echoing it back.
  const verifier = readString(payload?.verifier);
  const callbackId = payload?.object_id != null ? String(payload.object_id) : undefined;
  if (verifier && callbackId) {
    await context.state.set(WEBHOOK_STATE_KEY, { callbackId, verifier } as StoredWebhookState);
    try {
      await getOrCreateClient(context).verifyCallback(callbackId, verifier);
    } catch (err) {
      context.logger.warn('FreshBooks callback verification failed', { callbackId, error: String(err) });
    }
    return { system: SYSTEM, status: 'handshake', syncedCount: 0, details: { callbackId } };
  }

  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  if (syncDirection === 'timesheet-to-freshbooks' || syncDirection === 'timesheet-to-external') {
    return skip({ reason: 'sync-direction-mismatch' });
  }

  const stored = (await context.state.get<StoredWebhookState>(WEBHOOK_STATE_KEY)) ?? undefined;
  const secret = stored?.verifier ?? context.config?.webhookSecret;
  const signature = getHeader(input, 'x-freshbooks-hmac-sha256');
  const rawBody = getRawBody(input);

  // The backend may have already verified and routed the delivery; otherwise
  // fail closed unless we hold a verifier to authenticate the signature.
  if (input?.verified !== true) {
    if (!secret) {
      return { system: SYSTEM, status: 'rejected', syncedCount: 0, details: { reason: 'not-verified' } };
    }
    if (!signature || !rawBody) {
      return { system: SYSTEM, status: 'rejected', syncedCount: 0, details: { reason: 'missing-signature-or-body' } };
    }
    if (!(await verifyFreshBooksSignature(rawBody, signature, secret))) {
      context.logger.warn('FreshBooks webhook rejected: signature mismatch');
      return { system: SYSTEM, status: 'rejected', syncedCount: 0, details: { reason: 'invalid-signature' } };
    }
  }

  const eventName = readString(payload?.name);
  const objectId = payload?.object_id != null ? String(payload.object_id) : undefined;
  if (!eventName || !objectId) {
    return { system: SYSTEM, status: 'ignored', syncedCount: 0, details: { reason: 'no-event' } };
  }
  if (!eventName.startsWith('time_entry')) {
    return { system: SYSTEM, status: 'ignored', syncedCount: 0, details: { reason: 'non-time-entry-event', eventName } };
  }

  if (eventName.endsWith('.delete')) {
    const removed = await deleteLocalTaskByExternalId(context, objectId);
    return {
      system: SYSTEM,
      status: 'completed',
      syncedCount: removed ? 1 : 0,
      details: { eventName, objectId }
    };
  }

  return syncTaskFromFreshBooks({ externalTaskId: objectId }, context);
}

export async function syncTaskFromFreshBooks(
  input: SyncInput,
  context: IntegrationContext<FreshBooksConfig>
): Promise<FreshBooksSyncResult> {
  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  if (syncDirection === 'timesheet-to-freshbooks' || syncDirection === 'timesheet-to-external') {
    return skip({ reason: 'sync-direction-mismatch' });
  }

  const externalTaskId = input?.externalTaskId;
  if (!externalTaskId) {
    return skip({ reason: 'missing-external-task-id' });
  }

  const projectMappings = await context.mappings.list({ system: SYSTEM, entity: PROJECT_ENTITY });
  const userMappings = await context.mappings.list({ system: SYSTEM, entity: USER_ENTITY });
  const rateMappings = await context.mappings.list({ system: SYSTEM, entity: RATE_ENTITY });
  const projectByExternalId = new Map(projectMappings.map((mapping) => [mapping.externalId, mapping.localId]));
  const userByExternalId = new Map(userMappings.map((mapping) => [mapping.externalId, mapping.localId]));
  const rateByExternalId = new Map(rateMappings.map((mapping) => [mapping.externalId, mapping.localId]));

  const client = getOrCreateClient(context);
  const entry = await client.getTimeEntry(externalTaskId);
  if (!entry) {
    const removed = await deleteLocalTaskByExternalId(context, externalTaskId);
    return {
      system: SYSTEM,
      status: 'completed',
      syncedCount: removed ? 1 : 0,
      details: { externalTaskId, reason: removed ? 'deleted-missing-entry' : 'entry-not-found' }
    };
  }

  const synced = await syncSingleExternalEntry(entry, context, projectByExternalId, userByExternalId, rateByExternalId);
  return {
    system: SYSTEM,
    status: 'completed',
    syncedCount: synced ? 1 : 0,
    details: { externalTaskId }
  };
}

async function syncSingleExternalEntry(
  entry: FreshBooksTimeEntry,
  context: IntegrationContext<FreshBooksConfig>,
  projectByExternalId: Map<string, string>,
  userByExternalId: Map<string, string>,
  rateByExternalId: Map<string, string>
): Promise<boolean> {
  if (!entry?.id) {
    return false;
  }

  const externalProjectId = entry.project_id != null ? String(entry.project_id) : undefined;
  const externalUserId = entry.identity_id != null ? String(entry.identity_id) : undefined;
  if (!externalProjectId || !externalUserId) {
    return false;
  }

  const localProjectId = projectByExternalId.get(externalProjectId);
  const localUserId = userByExternalId.get(externalUserId);
  if (!localProjectId || !localUserId) {
    return false;
  }

  // Only set the rate when the service is mapped — an absent or unmapped
  // service must not clear a locally assigned rate.
  const externalServiceId = entry.service_id != null ? String(entry.service_id) : undefined;
  const localRateId = externalServiceId ? rateByExternalId.get(externalServiceId) : undefined;

  const dateRange = entryToDateRange(entry);
  if (!dateRange) {
    return false;
  }

  const desired: DesiredTaskFields = {
    projectId: localProjectId,
    userId: localUserId,
    startDateTime: dateRange.startDateTime,
    endDateTime: dateRange.endDateTime,
    description: entry.note ?? '',
    billable: entry.billable ?? false,
    ...(localRateId ? { rateId: localRateId } : {})
  };

  const taskMapping = await context.mappings.findByExternal({
    system: SYSTEM,
    entity: TASK_ENTITY,
    externalId: String(entry.id)
  });

  if (!taskMapping?.localId) {
    const importLockKey = getEntryImportLockStateKey(entry);
    if (!(await tryAcquireStateLock(context.state, importLockKey, IMPORT_LOCK_TTL_SECONDS))) {
      context.logger.info('FreshBooks time entry import already in progress, skipping duplicate create', {
        timeEntryId: entry.id
      });
      return false;
    }

    let created: TaskDto;
    try {
      created = await context.data.createTask({
        projectId: desired.projectId,
        userId: desired.userId,
        startDateTime: desired.startDateTime,
        endDateTime: desired.endDateTime,
        description: desired.description,
        billable: desired.billable,
        billed: entry.billed ?? false,
        ...(desired.rateId ? { rateId: desired.rateId } : {})
      } as TaskCreateInput);
    } catch (err) {
      // No task was created — release the lock so the retry can import the
      // entry instead of skipping it as a duplicate and losing it.
      await releaseStateLock(context.state, importLockKey);
      throw err;
    }

    await upsertTaskMapping(context, created.id, entry, desired, getLastUpdateMillis(created) || Date.now());
    return true;
  }

  const existing = await context.data.getTask(taskMapping.localId);
  // FreshBooks time entries carry no external `updated_at`, so the echo of our
  // own outbound write is detected by comparing content: if the entry already
  // matches the local task there is nothing to apply, and re-writing it would
  // bump the task's lastUpdate and restart the loop.
  if (!taskDiffersFromDesired(existing, desired)) {
    return false;
  }

  const updated = await context.data.updateTask(taskMapping.localId, {
    projectId: desired.projectId,
    startDateTime: desired.startDateTime,
    endDateTime: desired.endDateTime,
    description: desired.description,
    billable: desired.billable,
    billed: entry.billed ?? false,
    ...(desired.rateId ? { rateId: desired.rateId } : {})
  } as TaskUpdateInput);

  // Re-stamp with the post-write lastUpdate so the resulting task.update event
  // is recognised as our own echo and skipped outbound.
  await upsertTaskMapping(context, taskMapping.localId, entry, desired, getLastUpdateMillis(updated) || Date.now());
  return true;
}

// ============================================================================
// Webhook registration
// ============================================================================

export async function registerFreshBooksWebhooks(
  context: IntegrationContext<FreshBooksConfig>
): Promise<FreshBooksSyncResult> {
  const webhookUrl = context.metadata?.webhooks?.['integration-webhook'];
  if (!webhookUrl) {
    return skip({ reason: 'no-webhook-url' });
  }

  const client = getOrCreateClient(context);
  const existing = await client.listCallbacks();
  const alreadyRegistered = existing.some(
    (callback) => callback.uri === webhookUrl && (callback.event ?? '').startsWith('time_entry')
  );
  if (alreadyRegistered) {
    return { system: SYSTEM, status: 'completed', syncedCount: 0, details: { reason: 'already-registered' } };
  }

  // A single `time_entry` subscription catches create/update/delete under one
  // verifier, so there is exactly one HMAC secret to store.
  const callback = await client.createCallback('time_entry', webhookUrl);
  return {
    system: SYSTEM,
    status: 'completed',
    syncedCount: callback?.callbackid ? 1 : 0,
    details: { callbackId: callback?.callbackid ?? null, uri: webhookUrl }
  };
}

// ============================================================================
// Helpers
// ============================================================================

async function upsertTaskMapping(
  context: IntegrationContext<FreshBooksConfig>,
  localId: string,
  entry: FreshBooksTimeEntry,
  desired: DesiredTaskFields,
  localLastUpdateMillis: number
): Promise<void> {
  await context.mappings.upsert({
    system: SYSTEM,
    entity: TASK_ENTITY,
    localId,
    externalId: String(entry.id),
    externalLabel: entry.note ?? String(entry.id),
    metadata: buildTaskMappingMetadata({
      projectId: entry.project_id != null ? String(entry.project_id) : '',
      identityId: entry.identity_id != null ? String(entry.identity_id) : '',
      serviceId: entry.service_id != null ? String(entry.service_id) : undefined,
      clientId: entry.client_id != null ? String(entry.client_id) : undefined,
      localLastUpdateMillis
    }),
    syncStatus: 'SYNCED'
  });
}

async function deleteLocalTaskByExternalId(
  context: IntegrationContext<FreshBooksConfig>,
  externalId: string
): Promise<boolean> {
  const mapping = await context.mappings.findByExternal({
    system: SYSTEM,
    entity: TASK_ENTITY,
    externalId
  });
  if (!mapping?.localId) {
    return false;
  }
  try {
    await context.data.deleteTask(mapping.localId);
  } catch (err) {
    context.logger.warn('Failed to delete local task for FreshBooks delete event', {
      localId: mapping.localId,
      externalId,
      error: String(err)
    });
  }
  await context.mappings.delete({ system: SYSTEM, entity: TASK_ENTITY, localId: mapping.localId });
  return true;
}

async function resolveClientId(
  client: FreshBooksClient,
  projectMapping: MappingRecord,
  taskId: string,
  context: IntegrationContext<FreshBooksConfig>
): Promise<number | null> {
  const cached = readMetadataString(projectMapping.metadata ?? {}, 'clientId')
    ?? readMetadataString(projectMapping.metadata ?? {}, 'client_id');
  if (cached) {
    const numeric = Number(cached);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  try {
    return await client.resolveClientId(projectMapping.externalId);
  } catch (err) {
    context.logger.warn('Failed to resolve FreshBooks client for project', {
      taskId,
      projectExternalId: projectMapping.externalId,
      error: String(err)
    });
    return null;
  }
}

async function getMapping(
  context: IntegrationContext<FreshBooksConfig>,
  cache: Map<string, MappingRecord> | undefined,
  entity: string,
  localId: string
): Promise<MappingRecord | null> {
  if (cache) {
    return cache.get(localId) ?? null;
  }
  return context.mappings.get({ system: SYSTEM, entity, localId });
}

async function loadTask(
  taskId: string,
  input: SyncInput,
  context: IntegrationContext<FreshBooksConfig>
): Promise<TaskDto | null> {
  // Prefer the inline sync payload — normalize its flat fields to the nested
  // API shape (project: { id }) used downstream.
  if (input?.item && typeof input.item === 'object' && (input.item.id || input.item.taskId)) {
    const raw = input.item as Record<string, unknown>;
    const projectId = raw.projectId as string | undefined;
    if (!raw.project && projectId) {
      raw.project = { id: projectId };
    }
    const userId = raw.userId as string | undefined;
    if (!raw.user && userId) {
      raw.user = userId;
    }
    const rateId = raw.rateId as string | undefined;
    if (!raw.rate && rateId) {
      raw.rate = { id: rateId };
    }
    if (!raw.id && raw.taskId) {
      raw.id = raw.taskId;
    }
    return raw as unknown as TaskDto;
  }
  try {
    return await context.data.getTask(taskId);
  } catch {
    return null;
  }
}

function resolveTaskId(input: SyncInput): string | undefined {
  return input?.taskId || input?.entityId || input?.item?.taskId || input?.item?.id;
}

function buildTimeEntryPayload(input: {
  projectExternalId: string;
  userExternalId: string;
  clientId: number | null;
  serviceExternalId?: string;
  durationSeconds: number;
  startedAt: string;
  note: string;
  billable: boolean;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    is_logged: true,
    duration: input.durationSeconds,
    started_at: input.startedAt,
    note: input.note,
    project_id: toNumberOrString(input.projectExternalId),
    identity_id: toNumberOrString(input.userExternalId),
    billable: input.billable
  };
  if (input.clientId != null) {
    payload.client_id = input.clientId;
  }
  if (input.serviceExternalId) {
    payload.service_id = toNumberOrString(input.serviceExternalId);
  }
  return payload;
}

// Net worked seconds: FreshBooks bills the tracked time excluding breaks, which
// is how `duration - durationBreak` is reported elsewhere in the platform.
function computeDurationSeconds(task: TaskDto): number | null {
  const gross = Number(task.duration);
  const breakSeconds = Number(task.durationBreak ?? 0);
  const safeBreak = Number.isFinite(breakSeconds) && breakSeconds > 0 ? breakSeconds : 0;

  if (Number.isFinite(gross) && gross > 0) {
    return Math.max(0, Math.round(gross - safeBreak));
  }

  const start = parseDate(task.startDateTime);
  const end = parseDate(task.endDateTime);
  if (start && end) {
    const seconds = Math.round((end.getTime() - start.getTime()) / 1000) - safeBreak;
    return Math.max(0, seconds);
  }
  return null;
}

// FreshBooks `started_at` is UTC ISO 8601 (e.g. 2010-10-17T05:45:53Z).
function toStartedAt(value: string | undefined): string | null {
  const date = parseDate(value);
  if (!date) {
    return null;
  }
  return `${date.toISOString().slice(0, 19)}Z`;
}

// The Timesheet API datetime format is `yyyy-MM-dd'T'HH:mm:ssxxx`; emit an
// explicit +00:00 offset rather than a trailing 'Z' (which the API rejects).
function toApiDateTime(date: Date): string {
  return `${date.toISOString().slice(0, 19)}+00:00`;
}

function entryToDateRange(entry: FreshBooksTimeEntry): { startDateTime: string; endDateTime: string } | null {
  const start = parseDate(entry.started_at);
  if (!start) {
    return null;
  }
  const durationSeconds = Number(entry.duration ?? 0);
  const safeDuration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;
  const end = new Date(start.getTime() + safeDuration * 1000);
  return {
    startDateTime: toApiDateTime(start),
    endDateTime: toApiDateTime(end)
  };
}

// True when the incoming entry would change the local task. Used as the inbound
// echo guard in place of an external update timestamp.
function taskDiffersFromDesired(task: TaskDto | null | undefined, desired: DesiredTaskFields): boolean {
  if (!task) {
    return true;
  }
  const startEqual = sameInstant(task.startDateTime, desired.startDateTime);
  const endEqual = sameInstant(task.endDateTime, desired.endDateTime);
  const descEqual = (task.description ?? '') === desired.description;
  const billableEqual = (task.billable ?? false) === desired.billable;
  const projectEqual = (task.project?.id ?? '') === desired.projectId;
  const rateEqual = (task.rate?.id ?? undefined) === desired.rateId;
  return !(startEqual && endEqual && descEqual && billableEqual && projectEqual && rateEqual);
}

function sameInstant(a: string | undefined, b: string | undefined): boolean {
  const da = parseDate(a);
  const db = parseDate(b);
  if (!da || !db) {
    return da === db;
  }
  return da.getTime() === db.getTime();
}

function parseDate(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toNumberOrString(value: string): number | string {
  const numeric = Number(value);
  return Number.isFinite(numeric) && String(numeric) === value ? numeric : value;
}

function buildTaskMappingMetadata(input: {
  projectId: string;
  identityId: string;
  serviceId?: string;
  clientId?: string;
  localLastUpdateMillis?: number;
}): Record<string, string> {
  return {
    projectId: input.projectId,
    identityId: input.identityId,
    ...(input.serviceId ? { serviceId: input.serviceId } : {}),
    ...(input.clientId ? { clientId: input.clientId } : {}),
    // FreshBooks exposes no external update timestamp, so only the local stamp
    // is recorded (echo suppression is content-based on the inbound side).
    ...syncMetadataStamp({ localLastUpdateMillis: input.localLastUpdateMillis })
  };
}

function getEntryImportLockStateKey(entry: FreshBooksTimeEntry): string {
  const version = entry.created_at || String(entry.duration ?? '') || 'unknown';
  return `freshbooks:time-entry-import:${stableHash(`${entry.id}:${version}`)}`;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readMetadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function getHeader(input: SyncInput, name: string): string | undefined {
  const headers: Record<string, unknown> = { ...(input?.headers ?? {}) };
  if (input?.body && typeof input.body === 'object') {
    const nested = (input.body as { headers?: Record<string, unknown> }).headers;
    if (nested && typeof nested === 'object') {
      Object.assign(headers, nested);
    }
  }
  const target = name.toLowerCase();
  const key = Object.keys(headers).find((header) => header.toLowerCase() === target);
  if (!key) {
    return undefined;
  }
  const value = headers[key];
  return value === undefined || value === null ? undefined : String(value);
}

function getRawBody(input: SyncInput): string | undefined {
  if (typeof input?.rawBody === 'string' && input.rawBody.length > 0) {
    return input.rawBody;
  }
  if (typeof input?.body === 'string' && input.body.length > 0) {
    return input.body;
  }
  // Reconstructing JSON here only matches the HMAC if the runtime serialized
  // the parsed body identically to the request bytes — it typically doesn't,
  // so verification fails closed downstream.
  if (input?.body && typeof input.body === 'object') {
    try {
      return JSON.stringify(input.body);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseWebhookPayload(body: unknown, rawBody: string | undefined): FreshBooksWebhookPayload | null {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return body as FreshBooksWebhookPayload;
  }
  const raw = rawBody ?? (typeof body === 'string' ? body : undefined);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as FreshBooksWebhookPayload;
  } catch {
    // FreshBooks posts application/x-www-form-urlencoded bodies.
    return parseFormEncoded(raw);
  }
}

function parseFormEncoded(raw: string): FreshBooksWebhookPayload | null {
  try {
    const params = new URLSearchParams(raw);
    const out: Record<string, string> = {};
    params.forEach((value, key) => {
      out[key] = value;
    });
    return Object.keys(out).length > 0 ? (out as FreshBooksWebhookPayload) : null;
  } catch {
    return null;
  }
}

// Web Crypto is used so this plugin works in sandboxed runtimes (esbuild bundler
// without Node built-ins). Both Node 18+ and the plugin runtime expose
// `globalThis.crypto.subtle`.
async function verifyFreshBooksSignature(rawBody: string, signatureHeader: string, secret: string): Promise<boolean> {
  // FreshBooks signs the raw request body with HMAC-SHA256 keyed on the
  // callback verifier, and sends the digest as base64 in
  // `X-FreshBooks-Hmac-SHA256`.
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const expected = bufferToBase64(signatureBuffer);
  return constantTimeEquals(expected, signatureHeader);
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(binary, 'binary').toString('base64');
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function skip(details: Record<string, unknown>): FreshBooksSyncResult {
  return { system: SYSTEM, status: 'skipped', syncedCount: 0, details };
}
