import {
  IntegrationContext,
  MappingRecord,
  TaskCreateInput,
  TaskDto,
  TaskUpdateInput,
  ToDoCreateInput,
  ToDoDto,
  ToDoUpdateInput,
  getLastUpdateMillis,
  isAlreadySyncedLocalChange,
  isStaleExternalChange,
  releaseStateLock,
  syncMetadataStamp,
  tryAcquireStateLock
} from '@timesheet/integration-sdk';
import { BasecampClient, isBasecampStatus } from './basecampClient';
import {
  BasecampConfig,
  BasecampProject,
  BasecampTimesheetEntry,
  BasecampTimesheetEntryPayload,
  BasecampTodo,
  BasecampWebhookPayload,
  SyncInput
} from './types';

const SYSTEM = 'basecamp';
const PROJECT_ENTITY = 'project';
const TODO_ENTITY = 'todo';
const TASK_ENTITY = 'task';
const USER_ENTITY = 'user';
const SYNC_STATE_KEY = 'basecamp:last-sync-time';
const ACCOUNT_STATE_KEY = 'basecamp:account-id';
const TODOLIST_STATE_PREFIX = 'basecamp:todolist:';
const TIMESHEET_ENABLED_STATE_PREFIX = 'basecamp:timesheet-enabled:';
// Import locks close the webhook-vs-full-sync race on first import; held for
// the TTL (not released on success) so duplicate webhook deliveries stay
// suppressed until the new mapping is visible everywhere.
const IMPORT_LOCK_TTL_SECONDS = 60 * 60;
// The dock entry naming a project's to-do tool.
const TODOSET_DOCK_NAME = 'todoset';
// Only to-do events are actionable: Basecamp has no webhook type for timesheet
// entries, so inbound time changes arrive through the scheduled inbound sync.
const WEBHOOK_TYPES = ['Todo'];
// Recording states that mean "gone" in Timesheet terms. Basecamp has no hard
// delete, and its recordings feed lists active records only.
const REMOVED_RECORDING_STATUSES = ['trashed', 'archived'];

const TODO_STATUS_OPEN = 0;
const TODO_STATUS_CLOSED = 1;

export interface BasecampSyncResult {
  system: string;
  status: string;
  syncedCount: number;
  details?: Record<string, unknown>;
}

export interface SyncBatchCaches {
  projectMappingByLocalId?: Map<string, MappingRecord>;
  todoMappingByLocalId?: Map<string, MappingRecord>;
  taskMappingByLocalId?: Map<string, MappingRecord>;
  users?: UserMappingIndex;
}

/**
 * Both directions of the optional Timesheet user ↔ Basecamp person mapping.
 * `configured` is false on installations that never mapped anyone, which is the
 * normal single-user case: everything then behaves as it did before the mapping
 * existed, writing under the connected Basecamp account.
 */
export interface UserMappingIndex {
  localToExternal: Map<string, string>;
  externalToLocal: Map<string, string>;
  configured: boolean;
}

let sharedClient: BasecampClient | null = null;

export function resetSharedClient(): void {
  sharedClient = null;
}

export function createBasecampClient(context: IntegrationContext<BasecampConfig>): BasecampClient {
  return new BasecampClient({
    getAccessToken: () => context.credentials.getAccessToken(SYSTEM),
    refreshAccessToken: () => context.credentials.refreshToken(SYSTEM),
    loadCachedAccountId: () => context.state.get<string>(ACCOUNT_STATE_KEY),
    storeAccountId: (accountId) => context.state.set(ACCOUNT_STATE_KEY, accountId)
  });
}

function getOrCreateClient(context: IntegrationContext<BasecampConfig>): BasecampClient {
  if (!sharedClient) {
    sharedClient = createBasecampClient(context);
  }
  return sharedClient;
}

// ============================================================================
// Outbound: Timesheet ToDo  →  Basecamp to-do
// ============================================================================

export async function syncTodoToBasecamp(
  input: SyncInput,
  context: IntegrationContext<BasecampConfig>,
  caches?: SyncBatchCaches
): Promise<BasecampSyncResult> {
  if (!allowsOutbound(context)) {
    return skip({ reason: 'sync-direction-mismatch' });
  }

  const todoId = resolveTodoId(input);
  if (!todoId) {
    return skip({ reason: 'missing-todo-id' });
  }

  const todo = await loadTodo(todoId, input, context);
  if (!todo) {
    return skip({ reason: 'todo-not-found', todoId });
  }

  const projectId = todo.project?.id;
  if (!projectId) {
    return skip({ reason: 'missing-project', todoId });
  }

  const projectMapping = await getMapping(context, caches?.projectMappingByLocalId, PROJECT_ENTITY, projectId);
  if (!projectMapping?.externalId) {
    return skip({ reason: 'missing-project-mapping', projectId });
  }

  const client = getOrCreateClient(context);
  const todoMapping = await getMapping(context, caches?.todoMappingByLocalId, TODO_ENTITY, todo.id);

  if (todo.deleted) {
    if (todoMapping?.externalId) {
      try {
        await client.trashRecording(todoMapping.externalId);
      } catch (err) {
        context.logger.warn('Failed to trash Basecamp to-do for deleted todo', {
          externalId: todoMapping.externalId,
          error: String(err)
        });
      }
      await context.mappings.delete({ system: SYSTEM, entity: TODO_ENTITY, localId: todo.id });
      caches?.todoMappingByLocalId?.delete(todo.id);
      return { system: SYSTEM, status: 'deleted', syncedCount: 1 };
    }
    return skip({ reason: 'already-deleted' });
  }

  // Echo guard: a change not newer than our own last write for this todo is
  // the event fired by that write — syncing it back would ping-pong forever.
  if (todoMapping?.externalId && isAlreadySyncedLocalChange(todoMapping.metadata, getLastUpdateMillis(todo))) {
    return skip({ reason: 'already-synced-todo-change', todoId: todo.id });
  }

  const completed = todo.status === TODO_STATUS_CLOSED;
  const users = caches?.users ?? (await loadUserMappingIndex(context));
  let external: BasecampTodo | null = null;

  if (todoMapping?.externalId) {
    external = await client.getTodo(todoMapping.externalId);
  }

  if (external?.id) {
    // Basecamp clears any omitted field on update, so the existing assignees and
    // completion subscribers are carried over explicitly.
    await client.updateTodo(String(external.id), {
      ...buildTodoPayload(todo),
      assignee_ids: resolveAssigneeIds(todo, users, external),
      completion_subscriber_ids: (external.completion_subscribers ?? []).map((person) => person.id)
    });
    if ((external.completed ?? false) !== completed) {
      await client.setTodoCompletion(String(external.id), completed);
    }
    external = (await client.getTodo(String(external.id))) ?? external;
  } else {
    const todolistId = await resolveTodolistId(context, client, projectMapping.externalId);
    if (!todolistId) {
      return skip({ reason: 'missing-todolist', bucketId: projectMapping.externalId });
    }
    const assigneeIds = resolveAssigneeIds(todo, users, null);
    external = await client.createTodo(todolistId, {
      ...buildTodoPayload(todo),
      ...(assigneeIds.length > 0 ? { assignee_ids: assigneeIds } : {})
    });
    if (completed) {
      await client.setTodoCompletion(String(external.id), true);
      external = (await client.getTodo(String(external.id))) ?? external;
    }
  }

  const upserted: MappingRecord = {
    localId: todo.id,
    externalId: String(external.id),
    externalLabel: external.content ?? todo.name ?? todo.id,
    metadata: {
      bucketId: projectMapping.externalId,
      localProjectId: projectId,
      ...syncMetadataStamp({
        localLastUpdateMillis: getLastUpdateMillis(todo),
        externalUpdatedAt: external.updated_at,
        externalUpdatedKey: 'updatedAt'
      })
    },
    syncStatus: 'SYNCED'
  };

  await context.mappings.upsert({ system: SYSTEM, entity: TODO_ENTITY, ...upserted });
  caches?.todoMappingByLocalId?.set(todo.id, upserted);

  return {
    system: SYSTEM,
    status: 'synced',
    syncedCount: 1,
    details: { todoId: todo.id, externalTodoId: String(external.id) }
  };
}

// ============================================================================
// Outbound: Timesheet Task (time entry)  →  Basecamp timesheet entry
// ============================================================================

export async function syncTimesheetTaskToBasecamp(
  input: SyncInput,
  context: IntegrationContext<BasecampConfig>,
  caches?: SyncBatchCaches
): Promise<BasecampSyncResult> {
  if (!allowsOutbound(context)) {
    return skip({ reason: 'sync-direction-mismatch' });
  }
  if (context.config?.pushTimeEntries === 'off') {
    return skip({ reason: 'time-push-disabled' });
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

  const taskMapping = await getMapping(context, caches?.taskMappingByLocalId, TASK_ENTITY, task.id);
  const client = getOrCreateClient(context);

  // Echo guard: skip the event fired by our own inbound entry import/update.
  if (!task.deleted && taskMapping?.externalId
      && isAlreadySyncedLocalChange(taskMapping.metadata, getLastUpdateMillis(task))) {
    return skip({ reason: 'already-synced-task-change', taskId: task.id });
  }

  if (task.deleted) {
    if (taskMapping?.externalId) {
      try {
        await client.deleteTimesheetEntry(taskMapping.externalId);
      } catch (err) {
        context.logger.warn('Failed to delete Basecamp timesheet entry', {
          externalId: taskMapping.externalId,
          error: String(err)
        });
      }
      await context.mappings.delete({ system: SYSTEM, entity: TASK_ENTITY, localId: task.id });
      caches?.taskMappingByLocalId?.delete(task.id);
      return { system: SYSTEM, status: 'deleted', syncedCount: 1 };
    }
    return skip({ reason: 'already-deleted' });
  }

  // A timesheet entry hangs off a recording, and the only recording this plugin
  // owns is the Basecamp to-do mirrored from the Timesheet todo.
  const localTodoId = task.todo?.id;
  if (!localTodoId) {
    return skip({ reason: 'missing-todo-on-task', taskId });
  }

  const todoMapping = await getMapping(context, caches?.todoMappingByLocalId, TODO_ENTITY, localTodoId);
  if (!todoMapping?.externalId) {
    return skip({ reason: 'missing-todo-mapping', todoId: localTodoId });
  }

  const bucketId = readMetadataString(todoMapping.metadata ?? {}, 'bucketId');
  if (bucketId && !(await isTimesheetEnabled(context, client, bucketId))) {
    // Basecamp Timesheets is a paid add-on; without it the entry endpoints 403.
    // To-do sync keeps working, so this is a skip rather than an error.
    return skip({ reason: 'timesheet-not-enabled', bucketId });
  }

  const durationMinutes = computeDurationMinutes(task);
  if (durationMinutes == null) {
    return skip({ reason: 'invalid-task-duration', taskId: task.id });
  }
  if (durationMinutes <= 0) {
    return skip({ reason: 'zero-duration', taskId: task.id });
  }

  const date = toIsoDate(task.startDateTime);
  if (!date) {
    return skip({ reason: 'invalid-start-date', taskId: task.id });
  }

  const hours = minutesToHours(durationMinutes);
  const description = task.description?.trim() || undefined;

  // Without a user mapping the entry lands under the connected Basecamp account,
  // which is right for a single user and wrong for a team.
  const users = caches?.users ?? (await loadUserMappingIndex(context));
  const personId = task.user ? users.localToExternal.get(task.user) : undefined;
  if (users.configured && task.user && !personId) {
    context.logger.warn('No Basecamp person mapped for user, logging time under the connected account', {
      taskId: task.id,
      userId: task.user
    });
  }
  const payload = { date, hours, description, ...(personId ? { person_id: personId } : {}) };

  const external: BasecampTimesheetEntry = taskMapping?.externalId
    ? await writeTimesheetEntry(context, payload, (body) =>
        client.updateTimesheetEntry(taskMapping.externalId as string, body))
    : await writeTimesheetEntry(context, payload, (body) =>
        client.createTimesheetEntry(todoMapping.externalId as string, body));

  const upserted: MappingRecord = {
    localId: task.id,
    externalId: String(external.id),
    externalLabel: `${hours}h on ${date}`,
    metadata: {
      basecampTodoId: todoMapping.externalId,
      todoId: localTodoId,
      hours,
      date,
      ...(external.person?.id != null ? { personId: String(external.person.id) } : {}),
      ...syncMetadataStamp({ localLastUpdateMillis: getLastUpdateMillis(task) })
    },
    syncStatus: 'SYNCED'
  };

  await context.mappings.upsert({ system: SYSTEM, entity: TASK_ENTITY, ...upserted });
  caches?.taskMappingByLocalId?.set(task.id, upserted);

  return {
    system: SYSTEM,
    status: 'synced',
    syncedCount: 1,
    details: { taskId: task.id, externalEntryId: String(external.id), basecampTodoId: todoMapping.externalId }
  };
}

// ============================================================================
// Inbound: Basecamp  →  Timesheet (full sync + webhook handler)
// ============================================================================

export async function runBasecampFullSync(
  context: IntegrationContext<BasecampConfig>
): Promise<BasecampSyncResult> {
  const projectMappings = await context.mappings.list({ system: SYSTEM, entity: PROJECT_ENTITY });
  if (projectMappings.length === 0) {
    return skip({ reason: 'missing-project-mappings' });
  }

  // Webhooks are per project and Basecamp deactivates them after repeated
  // delivery failures, so the scheduled sync re-asserts them.
  const registered = await ensureWebhooks(context, projectMappings);

  if (!allowsInbound(context)) {
    return {
      system: SYSTEM,
      status: 'completed',
      syncedCount: 0,
      details: { syncDirection: syncDirection(context), reason: 'outbound-only', webhooksRegistered: registered }
    };
  }

  const bucketIds = projectMappings.map((mapping) => mapping.externalId).filter((id): id is string => !!id);
  const projectByExternalId = new Map(projectMappings.map((mapping) => [mapping.externalId, mapping.localId]));

  const lastSyncTime = (await context.state.get<string>(SYNC_STATE_KEY)) ?? undefined;
  const sinceMillis = lastSyncTime ? Date.parse(lastSyncTime) : 0;
  const startedAt = new Date().toISOString();
  const client = getOrCreateClient(context);
  const users = await loadUserMappingIndex(context);

  const recordings = await client.listTodoRecordings(bucketIds);

  const failures: Array<{ entity: string; externalId: string; error: string }> = [];

  let syncedCount = 0;
  for (const recording of recordings) {
    if (isOlderThanWatermark(recording.updated_at, sinceMillis)) {
      continue;
    }
    // One entity must not take the run down with it: a to-do the acting user
    // may not write, or a single malformed payload, would otherwise abort the
    // loop before the watermark advances and fail identically on every run.
    try {
      // The recordings feed is a discovery index; refetch when it omits the
      // to-do body so an incomplete payload never overwrites a local todo.
      const todo = recording.content ? recording : await client.getTodo(String(recording.id));
      if (!todo) {
        continue;
      }
      const synced = await upsertLocalTodoFromBasecampTodo(context, todo, projectByExternalId, users);
      if (synced) syncedCount += 1;
    } catch (err) {
      context.logger.warn('Failed to import Basecamp to-do', { externalId: String(recording.id), error: String(err) });
      failures.push({ entity: 'todo', externalId: String(recording.id), error: String(err) });
    }
  }

  const removedCount = await reconcileRemovedTodos(context, client, bucketIds, sinceMillis, failures);
  const entriesSynced = await importTimesheetEntries(context, client, projectMappings, sinceMillis, users, failures);

  await context.state.set(SYNC_STATE_KEY, startedAt);

  return {
    system: SYSTEM,
    status: failures.length > 0 ? 'partial' : 'completed',
    syncedCount: syncedCount + removedCount + entriesSynced,
    details: {
      syncDirection: syncDirection(context),
      sinceIso: lastSyncTime ?? null,
      mappedProjects: projectMappings.length,
      todosSynced: syncedCount,
      todosRemoved: removedCount,
      entriesSynced,
      webhooksRegistered: registered,
      failures: failures.length > 0 ? failures : undefined
    }
  };
}

/**
 * Applies removals the webhook never delivered. Basecamp's recordings feed
 * defaults to active records, so a to-do trashed or archived while the hook was
 * inactive (or on a client-role installation that cannot create hooks at all)
 * would otherwise stay in Timesheet forever. Both states are treated as gone,
 * matching what the webhook handler does with a non-active recording.
 */
async function reconcileRemovedTodos(
  context: IntegrationContext<BasecampConfig>,
  client: BasecampClient,
  bucketIds: string[],
  sinceMillis: number,
  failures: Array<{ entity: string; externalId: string; error: string }>
): Promise<number> {
  let removed = 0;
  for (const status of REMOVED_RECORDING_STATUSES) {
    let recordings: BasecampTodo[];
    try {
      recordings = await client.listTodoRecordings(bucketIds, status);
    } catch (err) {
      context.logger.warn('Failed to list removed Basecamp to-dos', { status, error: String(err) });
      continue;
    }

    for (const recording of recordings) {
      if (isOlderThanWatermark(recording.updated_at, sinceMillis)) {
        continue;
      }
      try {
        if (await deleteLocalTodoByExternalId(context, String(recording.id))) {
          removed += 1;
        }
      } catch (err) {
        context.logger.warn('Failed to remove local todo for a removed Basecamp to-do', {
          externalId: String(recording.id),
          error: String(err)
        });
        failures.push({ entity: 'todo', externalId: String(recording.id), error: String(err) });
      }
    }
  }
  return removed;
}

export async function handleBasecampWebhook(
  input: SyncInput,
  context: IntegrationContext<BasecampConfig>
): Promise<BasecampSyncResult> {
  if (!allowsInbound(context)) {
    return skip({ reason: 'sync-direction-mismatch' });
  }

  const payload = parseWebhookPayload(input.body, getRawBody(input));
  const recording = payload?.recording;
  const recordingId = recording?.id;
  if (!recordingId) {
    return { system: SYSTEM, status: 'ignored', syncedCount: 0, details: { reason: 'no-recording' } };
  }
  if (recording?.type && recording.type !== 'Todo') {
    return { system: SYSTEM, status: 'ignored', syncedCount: 0, details: { reason: 'unhandled-type', type: recording.type } };
  }

  const projectMappings = await context.mappings.list({ system: SYSTEM, entity: PROJECT_ENTITY });
  const projectByExternalId = new Map(projectMappings.map((mapping) => [mapping.externalId, mapping.localId]));

  const bucketId = recording?.bucket?.id != null ? String(recording.bucket.id) : undefined;
  if (bucketId && !projectByExternalId.has(bucketId)) {
    return { system: SYSTEM, status: 'ignored', syncedCount: 0, details: { reason: 'unmapped-bucket', bucketId } };
  }

  // Basecamp does not sign webhook deliveries, so the payload is only a hint:
  // the to-do is refetched with this installation's own token before it is
  // applied, which is what proves the event is real and in scope.
  const client = getOrCreateClient(context);
  const todo = await client.getTodo(String(recordingId));

  if (!todo || (todo.status && todo.status !== 'active')) {
    const removed = await deleteLocalTodoByExternalId(context, String(recordingId));
    return {
      system: SYSTEM,
      status: 'completed',
      syncedCount: removed ? 1 : 0,
      details: { kind: payload?.kind, recordingId, action: 'deleted' }
    };
  }

  const users = await loadUserMappingIndex(context);
  const synced = await upsertLocalTodoFromBasecampTodo(context, todo, projectByExternalId, users);
  return {
    system: SYSTEM,
    status: 'completed',
    syncedCount: synced ? 1 : 0,
    details: { kind: payload?.kind, recordingId }
  };
}

export async function syncTodoFromBasecamp(
  input: SyncInput,
  context: IntegrationContext<BasecampConfig>
): Promise<BasecampSyncResult> {
  if (!allowsInbound(context)) {
    return skip({ reason: 'sync-direction-mismatch' });
  }
  const externalTaskId = input?.externalTaskId;
  if (!externalTaskId) {
    return skip({ reason: 'missing-external-task-id' });
  }

  const projectMappings = await context.mappings.list({ system: SYSTEM, entity: PROJECT_ENTITY });
  const projectByExternalId = new Map(projectMappings.map((mapping) => [mapping.externalId, mapping.localId]));

  const client = getOrCreateClient(context);
  const todo = await client.getTodo(externalTaskId);
  if (!todo) {
    const removed = await deleteLocalTodoByExternalId(context, externalTaskId);
    return { system: SYSTEM, status: 'completed', syncedCount: removed ? 1 : 0, details: { action: 'deleted' } };
  }

  const users = await loadUserMappingIndex(context);
  const synced = await upsertLocalTodoFromBasecampTodo(context, todo, projectByExternalId, users);
  return { system: SYSTEM, status: 'completed', syncedCount: synced ? 1 : 0 };
}

// ============================================================================
// Webhook registration
// ============================================================================

export async function registerBasecampWebhooks(
  context: IntegrationContext<BasecampConfig>
): Promise<BasecampSyncResult> {
  const projectMappings = await context.mappings.list({ system: SYSTEM, entity: PROJECT_ENTITY });
  if (projectMappings.length === 0) {
    return skip({ reason: 'missing-project-mappings' });
  }
  const registered = await ensureWebhooks(context, projectMappings);
  return {
    system: SYSTEM,
    status: 'completed',
    syncedCount: registered,
    details: { mappedProjects: projectMappings.length, created: registered }
  };
}

async function ensureWebhooks(
  context: IntegrationContext<BasecampConfig>,
  projectMappings: MappingRecord[]
): Promise<number> {
  const webhookUrl = context.metadata?.webhooks?.['integration-webhook'];
  if (!webhookUrl) {
    return 0;
  }

  const client = getOrCreateClient(context);
  let created = 0;

  for (const mapping of projectMappings) {
    if (!mapping.externalId) continue;
    try {
      const existing = await client.listWebhooks(mapping.externalId);
      const match = existing.find((webhook) => webhook.payload_url === webhookUrl);
      if (match?.active) {
        continue;
      }
      // An inactive hook is one Basecamp gave up on; replace rather than reuse.
      if (match?.id) {
        await client.deleteWebhook(String(match.id));
      }
      await client.createWebhook(mapping.externalId, webhookUrl, WEBHOOK_TYPES);
      created += 1;
    } catch (err) {
      // Client-role Basecamp users get 403 on webhook endpoints; scheduled
      // syncs still cover them, so this must not fail the run.
      context.logger.warn('Failed to ensure Basecamp webhook', {
        bucketId: mapping.externalId,
        error: String(err)
      });
    }
  }
  return created;
}

// ============================================================================
// Inbound writers
// ============================================================================

async function upsertLocalTodoFromBasecampTodo(
  context: IntegrationContext<BasecampConfig>,
  basecampTodo: BasecampTodo,
  projectByExternalId: Map<string, string>,
  users: UserMappingIndex
): Promise<boolean> {
  if (!basecampTodo?.id) return false;

  const bucketId = basecampTodo.bucket?.id != null ? String(basecampTodo.bucket.id) : undefined;
  const localProjectId = bucketId ? projectByExternalId.get(bucketId) : undefined;
  if (!localProjectId) {
    return false;
  }

  const externalId = String(basecampTodo.id);
  const todoMapping = await context.mappings.findByExternal({
    system: SYSTEM,
    entity: TODO_ENTITY,
    externalId
  });

  const name = basecampTodo.content?.trim() || `Basecamp to-do ${externalId}`;
  const description = htmlToPlainText(basecampTodo.description) || undefined;
  const status = basecampTodo.completed ? TODO_STATUS_CLOSED : TODO_STATUS_OPEN;
  const dueDate = basecampTodo.due_on ?? undefined;
  const assignedUsers = resolveAssignedUsers(basecampTodo, users);

  if (!todoMapping?.localId) {
    // Import lock: a webhook delivery racing a full sync must not create the
    // same todo twice. Held for the TTL; released only when the create fails.
    const lockKey = `import:todo:${externalId}`;
    if (!(await tryAcquireStateLock(context.state, lockKey, IMPORT_LOCK_TTL_SECONDS))) {
      context.logger.info('Basecamp todo import already in progress, skipping duplicate create', { externalId });
      return false;
    }

    let created: ToDoDto;
    try {
      created = await context.data.createTodo({
        projectId: localProjectId,
        name,
        description,
        status,
        dueDate,
        ...(assignedUsers !== undefined ? { assignedUsers } : {})
      } as ToDoCreateInput);
    } catch (err) {
      await releaseStateLock(context.state, lockKey);
      throw err;
    }

    await context.mappings.upsert({
      system: SYSTEM,
      entity: TODO_ENTITY,
      localId: created.id,
      externalId,
      externalLabel: name,
      metadata: {
        bucketId: bucketId ?? '',
        localProjectId,
        ...syncMetadataStamp({
          localLastUpdateMillis: getLastUpdateMillis(created),
          externalUpdatedAt: basecampTodo.updated_at,
          externalUpdatedKey: 'updatedAt'
        })
      },
      syncStatus: 'SYNCED'
    });
    return true;
  }

  // Echo guard: an external change not newer than what this mapping already
  // recorded is the echo of our own outbound write (or a redelivery).
  if (isStaleExternalChange({
    metadata: todoMapping.metadata,
    metadataKey: 'updatedAt',
    externalUpdatedAt: basecampTodo.updated_at
  })) {
    return false;
  }

  const existing = await context.data.getTodo(todoMapping.localId);
  if (isStaleExternalChange({
    externalUpdatedAt: basecampTodo.updated_at,
    localLastUpdateMillis: getLastUpdateMillis(existing)
  })) {
    return false;
  }

  const updated = await context.data.updateTodo(todoMapping.localId, {
    name,
    description,
    status,
    dueDate,
    ...(assignedUsers !== undefined ? { assignedUsers } : {})
  } as ToDoUpdateInput);

  await context.mappings.upsert({
    system: SYSTEM,
    entity: TODO_ENTITY,
    localId: todoMapping.localId,
    externalId,
    externalLabel: name,
    metadata: {
      bucketId: bucketId ?? '',
      localProjectId,
      ...syncMetadataStamp({
        localLastUpdateMillis: getLastUpdateMillis(updated),
        externalUpdatedAt: basecampTodo.updated_at,
        externalUpdatedKey: 'updatedAt'
      })
    },
    syncStatus: 'SYNCED'
  });
  return true;
}

/**
 * Pulls Basecamp timesheet entries back into Timesheet tasks. Projects without
 * the Timesheets add-on are skipped: their timesheet endpoint is not available.
 */
async function importTimesheetEntries(
  context: IntegrationContext<BasecampConfig>,
  client: BasecampClient,
  projectMappings: MappingRecord[],
  sinceMillis: number,
  users: UserMappingIndex,
  failures: Array<{ entity: string; externalId: string; error: string }>
): Promise<number> {
  // Deliberately not gated on pushTimeEntries: that option says whether to
  // write time *into* Basecamp. Reading Basecamp's own time back is governed by
  // syncDirection, like every other inbound path.
  let synced = 0;
  for (const mapping of projectMappings) {
    if (!mapping.externalId) continue;
    if (!(await isTimesheetEnabled(context, client, mapping.externalId))) {
      continue;
    }

    let entries: BasecampTimesheetEntry[];
    try {
      entries = await client.listProjectTimesheetEntries(mapping.externalId);
    } catch (err) {
      context.logger.warn('Failed to list Basecamp timesheet entries', {
        bucketId: mapping.externalId,
        error: String(err)
      });
      continue;
    }

    for (const entry of entries) {
      if (isOlderThanWatermark(entry.updated_at, sinceMillis)) {
        continue;
      }
      try {
        const imported = await upsertLocalTaskFromBasecampEntry(context, entry, mapping.localId, users);
        if (imported) synced += 1;
      } catch (err) {
        context.logger.warn('Failed to import Basecamp timesheet entry', {
          externalId: String(entry.id),
          error: String(err)
        });
        failures.push({ entity: 'task', externalId: String(entry.id), error: String(err) });
      }
    }
  }
  return synced;
}

async function upsertLocalTaskFromBasecampEntry(
  context: IntegrationContext<BasecampConfig>,
  entry: BasecampTimesheetEntry,
  localProjectId: string,
  users: UserMappingIndex
): Promise<boolean> {
  const parentId = entry.parent?.id != null ? String(entry.parent.id) : undefined;
  if (!parentId || entry.parent?.type !== 'Todo') {
    // Entries logged against a message, document or the project timesheet have
    // no local counterpart to attach to.
    return false;
  }

  const todoMapping = await context.mappings.findByExternal({
    system: SYSTEM,
    entity: TODO_ENTITY,
    externalId: parentId
  });
  if (!todoMapping?.localId) {
    return false;
  }

  const dateRange = entryToTaskDateRange(entry);
  if (!dateRange) return false;

  const personId = entry.person?.id != null ? String(entry.person.id) : undefined;
  const localUserId = personId ? users.externalToLocal.get(personId) : undefined;
  if (users.configured && !localUserId) {
    // An installation that maps users expects per-member attribution. Importing
    // an unmapped person's time would silently book it on whoever the inbound
    // sync runs as, which is worse than not importing it at all.
    context.logger.info('Skipping Basecamp timesheet entry for an unmapped person', {
      entryId: String(entry.id),
      personId
    });
    return false;
  }

  const externalId = String(entry.id);
  const description = entry.description?.trim() || `Time logged in Basecamp (${formatHours(entry.hours)}h)`;

  const taskMapping = await context.mappings.findByExternal({
    system: SYSTEM,
    entity: TASK_ENTITY,
    externalId
  });

  if (!taskMapping?.localId) {
    const lockKey = `import:task:${externalId}`;
    if (!(await tryAcquireStateLock(context.state, lockKey, IMPORT_LOCK_TTL_SECONDS))) {
      context.logger.info('Basecamp entry import already in progress, skipping duplicate create', { externalId });
      return false;
    }

    let created: TaskDto;
    try {
      // Attribution is create-only: TaskUpdateInput carries no userId, so a task
      // imported for the wrong member cannot be moved later.
      created = await context.data.createTask({
        projectId: localProjectId,
        todoId: todoMapping.localId,
        startDateTime: dateRange.startDateTime,
        endDateTime: dateRange.endDateTime,
        description,
        ...(localUserId ? { userId: localUserId } : {})
      } as TaskCreateInput);
      if (localUserId && created?.user && created.user !== localUserId) {
        // The backend drops userId when the acting profile has no team features,
        // and silently books the task on itself. Since attribution cannot be
        // corrected on update, a wrong owner here is permanent.
        context.logger.error('Basecamp entry was booked on the wrong member', {
          entryId: externalId,
          requestedUserId: localUserId,
          actualUserId: created.user
        });
      }
    } catch (err) {
      await releaseStateLock(context.state, lockKey);
      throw err;
    }

    await context.mappings.upsert({
      system: SYSTEM,
      entity: TASK_ENTITY,
      localId: created.id,
      externalId,
      externalLabel: description,
      metadata: {
        basecampTodoId: parentId,
        todoId: todoMapping.localId,
        hours: formatHours(entry.hours),
        date: entry.date ?? '',
        ...(personId ? { personId } : {}),
        ...syncMetadataStamp({
          localLastUpdateMillis: getLastUpdateMillis(created),
          externalUpdatedAt: entry.updated_at,
          externalUpdatedKey: 'updatedAt'
        })
      },
      syncStatus: 'SYNCED'
    });
    return true;
  }

  if (isStaleExternalChange({
    metadata: taskMapping.metadata,
    metadataKey: 'updatedAt',
    externalUpdatedAt: entry.updated_at
  })) {
    return false;
  }

  const existing = await context.data.getTask(taskMapping.localId);
  if (isStaleExternalChange({
    externalUpdatedAt: entry.updated_at,
    localLastUpdateMillis: getLastUpdateMillis(existing)
  })) {
    return false;
  }

  const updated = await context.data.updateTask(taskMapping.localId, {
    projectId: localProjectId,
    todoId: todoMapping.localId,
    startDateTime: dateRange.startDateTime,
    endDateTime: dateRange.endDateTime,
    description
  } as TaskUpdateInput);

  await context.mappings.upsert({
    system: SYSTEM,
    entity: TASK_ENTITY,
    localId: taskMapping.localId,
    externalId,
    externalLabel: description,
    metadata: {
      basecampTodoId: parentId,
      todoId: todoMapping.localId,
      hours: formatHours(entry.hours),
      date: entry.date ?? '',
      ...(personId ? { personId } : {}),
      ...syncMetadataStamp({
        localLastUpdateMillis: getLastUpdateMillis(updated),
        externalUpdatedAt: entry.updated_at,
        externalUpdatedKey: 'updatedAt'
      })
    },
    syncStatus: 'SYNCED'
  });
  return true;
}

async function deleteLocalTodoByExternalId(
  context: IntegrationContext<BasecampConfig>,
  externalId: string
): Promise<boolean> {
  const mapping = await context.mappings.findByExternal({
    system: SYSTEM,
    entity: TODO_ENTITY,
    externalId
  });
  if (!mapping?.localId) return false;
  try {
    await context.data.deleteTodo(mapping.localId);
  } catch (err) {
    context.logger.warn('Failed to delete local todo for Basecamp to-do trash', {
      localId: mapping.localId,
      externalId,
      error: String(err)
    });
  }
  await context.mappings.delete({ system: SYSTEM, entity: TODO_ENTITY, localId: mapping.localId });
  return true;
}

// ============================================================================
// Basecamp project shape resolution
// ============================================================================

/**
 * Resolves the to-do list new to-dos are created in: the list named in config,
 * otherwise the project's first list. Cached in state because it costs two
 * calls (project dock, then to-do lists).
 */
async function resolveTodolistId(
  context: IntegrationContext<BasecampConfig>,
  client: BasecampClient,
  bucketId: string
): Promise<string | null> {
  const stateKey = `${TODOLIST_STATE_PREFIX}${bucketId}`;
  const cached = await context.state.get<string>(stateKey);
  if (cached) {
    return cached;
  }

  const project = await client.getProject(bucketId);
  const todoset = (project?.dock ?? []).find((entry) => entry.name === TODOSET_DOCK_NAME && entry.enabled !== false);
  if (!todoset?.id) {
    return null;
  }

  const todolists = await client.listTodolists(String(todoset.id));
  if (todolists.length === 0) {
    return null;
  }

  const preferredName = context.config?.todoListName?.trim().toLowerCase();
  const preferred = preferredName
    ? todolists.find((list) => (list.title ?? list.name ?? '').trim().toLowerCase() === preferredName)
    : undefined;
  const todolistId = String((preferred ?? todolists[0]).id);

  await context.state.set(stateKey, todolistId);
  return todolistId;
}

/** Basecamp Timesheets is a paid add-on, surfaced per project as `timesheet_enabled`. */
async function isTimesheetEnabled(
  context: IntegrationContext<BasecampConfig>,
  client: BasecampClient,
  bucketId: string
): Promise<boolean> {
  const stateKey = `${TIMESHEET_ENABLED_STATE_PREFIX}${bucketId}`;
  const cached = await context.state.get<boolean>(stateKey);
  if (typeof cached === 'boolean') {
    return cached;
  }

  let project: BasecampProject | null = null;
  try {
    project = await client.getProject(bucketId);
  } catch (err) {
    context.logger.warn('Failed to read Basecamp project for timesheet detection', {
      bucketId,
      error: String(err)
    });
    return false;
  }

  const enabled = project?.timesheet_enabled === true;
  // Short TTL: the add-on can be switched on at any time and the flag should
  // not stay stale for a whole billing cycle.
  await context.state.set(stateKey, enabled, { ttlSeconds: 60 * 60 * 24 });
  return enabled;
}

// ============================================================================
// User mapping (Timesheet user ↔ Basecamp person)
// ============================================================================

/**
 * Reads the optional user mapping once per invocation. Installations that never
 * mapped anyone get an empty, unconfigured index and keep the single-user
 * behavior: writes go under the connected Basecamp account and inbound entries
 * land on whoever the sync runs as.
 */
export async function loadUserMappingIndex(
  context: IntegrationContext<BasecampConfig>
): Promise<UserMappingIndex> {
  let records: MappingRecord[] = [];
  try {
    records = await context.mappings.list({ system: SYSTEM, entity: USER_ENTITY });
  } catch (err) {
    context.logger.warn('Failed to load Basecamp user mappings', { error: String(err) });
  }

  const localToExternal = new Map<string, string>();
  const externalToLocal = new Map<string, string>();
  for (const record of records) {
    if (!record.localId || !record.externalId) continue;
    localToExternal.set(record.localId, record.externalId);
    // Two Timesheet users may point at one Basecamp person; the first wins for
    // the inbound direction so imports stay deterministic.
    if (!externalToLocal.has(record.externalId)) {
      externalToLocal.set(record.externalId, record.localId);
    }
  }

  return { localToExternal, externalToLocal, configured: localToExternal.size > 0 };
}

/**
 * Basecamp assignee ids for a todo. Assignees with no Timesheet counterpart are
 * kept as they are: this sync owns only the mapped half of the list, and a
 * to-do `PUT` would otherwise drop everyone it does not name.
 */
function resolveAssigneeIds(
  todo: ToDoDto,
  users: UserMappingIndex,
  external: BasecampTodo | null
): number[] {
  const existing = (external?.assignees ?? []).map((person) => person.id);
  if (!users.configured) {
    return existing;
  }

  const assigned: number[] = [];
  for (const localUserId of parseAssignedUsers(todo.assignedUsers)) {
    const personId = Number(users.localToExternal.get(localUserId));
    if (Number.isFinite(personId) && personId > 0) {
      assigned.push(personId);
    }
  }

  const unmanaged = existing.filter((personId) => !users.externalToLocal.has(String(personId)));
  return Array.from(new Set([...assigned, ...unmanaged]));
}

/**
 * Timesheet's comma separated assignee list for a Basecamp to-do.
 *
 * An empty string clears the local assignment, which is what an unassigned
 * Basecamp to-do means. Undefined leaves it untouched: that is the ambiguous
 * case where Basecamp names only people this installation has not mapped, and
 * guessing would either drop a real assignee or invent one.
 */
function resolveAssignedUsers(basecampTodo: BasecampTodo, users: UserMappingIndex): string | undefined {
  if (!users.configured) {
    return undefined;
  }
  const assignees = basecampTodo.assignees ?? [];
  if (assignees.length === 0) {
    return '';
  }
  const localIds = assignees
    .map((person) => users.externalToLocal.get(String(person.id)))
    .filter((localId): localId is string => !!localId);
  return localIds.length > 0 ? Array.from(new Set(localIds)).join(',') : undefined;
}

/** True when an external record predates the last completed inbound sync. */
function isOlderThanWatermark(updatedAt: string | undefined, sinceMillis: number): boolean {
  if (!Number.isFinite(sinceMillis) || sinceMillis <= 0) {
    return false;
  }
  const updatedMillis = Date.parse(updatedAt ?? '');
  return Number.isFinite(updatedMillis) && updatedMillis <= sinceMillis;
}

function parseAssignedUsers(assignedUsers: string | undefined): string[] {
  if (!assignedUsers) return [];
  return assignedUsers
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/**
 * Writes a timesheet entry, retrying once without `person_id` when Basecamp
 * refuses the attribution. The connected account may not be allowed to log time
 * for someone else, and dropping the entry entirely is worse than dropping the
 * person it is filed under.
 */
async function writeTimesheetEntry(
  context: IntegrationContext<BasecampConfig>,
  payload: BasecampTimesheetEntryPayload,
  write: (payload: BasecampTimesheetEntryPayload) => Promise<BasecampTimesheetEntry>
): Promise<BasecampTimesheetEntry> {
  try {
    return await write(payload);
  } catch (err) {
    if (!payload.person_id || !(isBasecampStatus(err, 403) || isBasecampStatus(err, 422))) {
      throw err;
    }
    context.logger.warn('Basecamp refused the mapped person, writing the entry under the connected account', {
      personId: payload.person_id,
      error: String(err)
    });
    const { person_id: _personId, ...withoutPerson } = payload;
    return write(withoutPerson);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function syncDirection(context: IntegrationContext<BasecampConfig>): string {
  return context.config?.syncDirection ?? 'bidirectional';
}

function allowsOutbound(context: IntegrationContext<BasecampConfig>): boolean {
  const direction = syncDirection(context);
  return direction !== 'basecamp-to-timesheet' && direction !== 'external-to-timesheet';
}

function allowsInbound(context: IntegrationContext<BasecampConfig>): boolean {
  const direction = syncDirection(context);
  return direction !== 'timesheet-to-basecamp' && direction !== 'timesheet-to-external';
}

async function getMapping(
  context: IntegrationContext<BasecampConfig>,
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
  context: IntegrationContext<BasecampConfig>
): Promise<TaskDto | null> {
  if (input?.item && typeof input.item === 'object' && hasTaskShape(input.item)) {
    const raw = input.item as Record<string, unknown>;
    const projectId = raw.projectId as string | undefined;
    if (!raw.project && projectId) raw.project = { id: projectId };
    const todoId = raw.todoId as string | undefined;
    if (!raw.todo && todoId) raw.todo = { id: todoId };
    if (!raw.id && raw.taskId) raw.id = raw.taskId;
    return raw as unknown as TaskDto;
  }
  try {
    return await context.data.getTask(taskId);
  } catch {
    return null;
  }
}

async function loadTodo(
  todoId: string,
  input: SyncInput,
  context: IntegrationContext<BasecampConfig>
): Promise<ToDoDto | null> {
  if (input?.item && typeof input.item === 'object' && hasTodoShape(input.item)) {
    const raw = input.item as Record<string, unknown>;
    const projectId = raw.projectId as string | undefined;
    if (!raw.project && projectId) raw.project = { id: projectId };
    if (!raw.id && raw.todoId) raw.id = raw.todoId;
    return raw as unknown as ToDoDto;
  }
  try {
    return await context.data.getTodo(todoId);
  } catch {
    return null;
  }
}

function hasTaskShape(item: Record<string, unknown>): boolean {
  // Tasks always have a start/end datetime; todos don't.
  return 'startDateTime' in item || 'endDateTime' in item || 'taskId' in item || 'running' in item;
}

function hasTodoShape(item: Record<string, unknown>): boolean {
  return 'name' in item || 'todoId' in item || 'estimatedHours' in item;
}

function resolveTaskId(input: SyncInput): string | undefined {
  return (
    input?.taskId ||
    input?.entityId ||
    (input?.item as Record<string, unknown> | undefined)?.taskId as string | undefined ||
    (input?.item as Record<string, unknown> | undefined)?.id as string | undefined
  );
}

function resolveTodoId(input: SyncInput): string | undefined {
  return (
    input?.entityId ||
    (input?.item as Record<string, unknown> | undefined)?.todoId as string | undefined ||
    (input?.item as Record<string, unknown> | undefined)?.id as string | undefined
  );
}

function buildTodoPayload(todo: ToDoDto): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    content: todo.name?.trim() || `Todo ${todo.id}`,
    // Basecamp renders the description as rich text, so plain text is wrapped.
    description: todo.description ? `<div>${escapeHtml(todo.description)}</div>` : ''
  };
  if (todo.dueDate) {
    payload.due_on = todo.dueDate.length > 10 ? todo.dueDate.slice(0, 10) : todo.dueDate;
  }
  return payload;
}

function computeDurationMinutes(task: TaskDto): number | null {
  // task.duration and task.durationBreak are in seconds; net worked seconds
  // convert to whole minutes with a /60 divisor.
  if (typeof task.duration === 'number' && task.duration > 0) {
    return Math.max(0, Math.round((task.duration - (task.durationBreak ?? 0)) / 60));
  }
  const start = parseDate(task.startDateTime);
  const end = parseDate(task.endDateTime);
  if (!start || !end) return null;
  // The start/end delta is milliseconds; durationBreak (seconds) is scaled to
  // match before subtracting.
  const ms = end.getTime() - start.getTime() - (task.durationBreak ?? 0) * 1000;
  return ms <= 0 ? 0 : Math.round(ms / 60_000);
}

/** Basecamp accepts decimal hours as a string; two places matches its own output. */
function minutesToHours(minutes: number): string {
  return (minutes / 60).toFixed(2);
}

function formatHours(hours: string | number | undefined): string {
  const parsed = parseHours(hours);
  return parsed == null ? '0.00' : parsed.toFixed(2);
}

/** Basecamp reports hours either as decimal ("1.5") or clock time ("1:30"). */
function parseHours(hours: string | number | undefined): number | null {
  if (typeof hours === 'number') {
    return Number.isFinite(hours) ? hours : null;
  }
  if (typeof hours !== 'string' || hours.trim().length === 0) {
    return null;
  }
  const value = hours.trim();
  if (value.includes(':')) {
    const [rawHours, rawMinutes] = value.split(':');
    const h = Number(rawHours);
    const m = Number(rawMinutes);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return h + m / 60;
  }
  const decimal = Number(value);
  return Number.isFinite(decimal) ? decimal : null;
}

function toIsoDate(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function entryToTaskDateRange(entry: BasecampTimesheetEntry): { startDateTime: string; endDateTime: string } | null {
  if (!entry.date) return null;
  const start = new Date(`${entry.date}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return null;
  const hours = parseHours(entry.hours);
  if (hours == null || hours < 0) return null;
  const end = new Date(start.getTime() + Math.round(hours * 60) * 60_000);
  return { startDateTime: start.toISOString(), endDateTime: end.toISOString() };
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function htmlToPlainText(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .trim();
}

function getRawBody(input: SyncInput): string | undefined {
  if (typeof input?.rawBody === 'string' && input.rawBody.length > 0) return input.rawBody;
  if (typeof input?.body === 'string' && input.body.length > 0) return input.body;
  return undefined;
}

function parseWebhookPayload(body: unknown, rawBody: string | undefined): BasecampWebhookPayload | null {
  if (body && typeof body === 'object') return body as BasecampWebhookPayload;
  if (rawBody) {
    try {
      return JSON.parse(rawBody) as BasecampWebhookPayload;
    } catch {
      return null;
    }
  }
  return null;
}

function readMetadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  if (typeof value === 'string' && value.trim().length > 0) return value;
  return undefined;
}

function skip(details: Record<string, unknown>): BasecampSyncResult {
  return { system: SYSTEM, status: 'skipped', syncedCount: 0, details };
}
