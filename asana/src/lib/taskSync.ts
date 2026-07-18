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
import { AsanaClient } from './asanaClient';
import {
  AsanaConfig,
  AsanaTask,
  AsanaTimeTrackingEntry,
  AsanaWebhookPayload,
  SyncInput
} from './types';

const SYSTEM = 'asana';
const PROJECT_ENTITY = 'project';
const TODO_ENTITY = 'todo';
const TASK_ENTITY = 'task';
const SYNC_STATE_KEY = 'asana:last-sync-time';
// Import locks close the webhook-vs-full-sync race on first import; held for
// the TTL (not released on success) so duplicate webhook deliveries stay
// suppressed until the new mapping is visible everywhere.
const IMPORT_LOCK_TTL_SECONDS = 60 * 60;

const TODO_STATUS_OPEN = 0;
const TODO_STATUS_CLOSED = 1;

export interface AsanaSyncResult {
  system: string;
  status: string;
  syncedCount: number;
  details?: Record<string, unknown>;
}

export interface SyncBatchCaches {
  projectMappingByLocalId?: Map<string, MappingRecord>;
  todoMappingByLocalId?: Map<string, MappingRecord>;
  taskMappingByLocalId?: Map<string, MappingRecord>;
}

let sharedClient: AsanaClient | null = null;

export function resetSharedClient(): void {
  sharedClient = null;
}

export function createAsanaClient(context: IntegrationContext<AsanaConfig>): AsanaClient {
  return new AsanaClient({
    getAccessToken: () => context.credentials.getAccessToken(SYSTEM),
    refreshAccessToken: () => context.credentials.refreshToken(SYSTEM),
    workspaceId: context.config?.workspaceId
  });
}

function getOrCreateClient(context: IntegrationContext<AsanaConfig>): AsanaClient {
  if (!sharedClient) {
    sharedClient = createAsanaClient(context);
  }
  return sharedClient;
}

// ============================================================================
// Outbound: Timesheet ToDo  →  Asana Task
// ============================================================================

export async function syncTodoToAsana(
  input: SyncInput,
  context: IntegrationContext<AsanaConfig>,
  caches?: SyncBatchCaches
): Promise<AsanaSyncResult> {
  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  if (syncDirection === 'asana-to-timesheet' || syncDirection === 'external-to-timesheet') {
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
        await client.deleteTask(todoMapping.externalId);
      } catch (err) {
        context.logger.warn('Failed to delete Asana task for deleted todo', {
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

  const payload = buildAsanaTaskPayloadFromTodo(todo);

  let external: AsanaTask;
  if (todoMapping?.externalId) {
    const existing = await client.getTask(todoMapping.externalId);
    if (existing?.gid) {
      external = await client.updateTask(existing.gid, payload);
    } else {
      external = await client.createTask({ ...payload, projects: [projectMapping.externalId] });
    }
  } else {
    external = await client.createTask({ ...payload, projects: [projectMapping.externalId] });
  }

  const upserted: MappingRecord = {
    localId: todo.id,
    externalId: external.gid,
    externalLabel: external.name ?? todo.name ?? todo.id,
    metadata: {
      projectId: projectMapping.externalId,
      localProjectId: projectId,
      ...syncMetadataStamp({
        localLastUpdateMillis: getLastUpdateMillis(todo),
        externalUpdatedAt: external.modified_at,
        externalUpdatedKey: 'modifiedAt'
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
    details: { todoId: todo.id, externalTaskGid: external.gid }
  };
}

// ============================================================================
// Outbound: Timesheet Task (time entry)  →  Asana time_tracking_entry
// ============================================================================

export async function syncTimesheetTaskToAsana(
  input: SyncInput,
  context: IntegrationContext<AsanaConfig>,
  caches?: SyncBatchCaches
): Promise<AsanaSyncResult> {
  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  if (syncDirection === 'asana-to-timesheet' || syncDirection === 'external-to-timesheet') {
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
        await client.deleteTimeTrackingEntry(taskMapping.externalId);
      } catch (err) {
        context.logger.warn('Failed to delete Asana time-tracking entry', {
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

  // A time-tracking entry can only exist on an Asana task — so we need a
  // todo→Asana-task mapping. If the Timesheet task isn't linked to a todo,
  // there's no target to log against.
  const localTodoId = task.todo?.id;
  if (!localTodoId) {
    return skip({ reason: 'missing-todo-on-task', taskId });
  }

  const todoMapping = await getMapping(context, caches?.todoMappingByLocalId, TODO_ENTITY, localTodoId);
  if (!todoMapping?.externalId) {
    return skip({ reason: 'missing-todo-mapping', todoId: localTodoId });
  }

  const durationMinutes = computeDurationMinutes(task);
  if (durationMinutes == null) {
    return skip({ reason: 'invalid-task-duration', taskId: task.id });
  }
  if (durationMinutes <= 0) {
    return skip({ reason: 'zero-duration', taskId: task.id });
  }

  const enteredOn = toEnteredOn(task.startDateTime);
  if (!enteredOn) {
    return skip({ reason: 'invalid-start-date', taskId: task.id });
  }

  let external: AsanaTimeTrackingEntry;
  if (taskMapping?.externalId) {
    external = await client.updateTimeTrackingEntry(taskMapping.externalId, {
      duration_minutes: durationMinutes,
      entered_on: enteredOn
    });
  } else {
    external = await client.createTimeTrackingEntry(todoMapping.externalId, {
      duration_minutes: durationMinutes,
      entered_on: enteredOn
    });
  }

  const upserted: MappingRecord = {
    localId: task.id,
    externalId: external.gid,
    externalLabel: `${durationMinutes}m on ${enteredOn}`,
    metadata: {
      asanaTaskGid: todoMapping.externalId,
      todoId: localTodoId,
      durationMinutes: String(durationMinutes),
      enteredOn,
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
    details: { taskId: task.id, externalEntryGid: external.gid, asanaTaskGid: todoMapping.externalId }
  };
}

// ============================================================================
// Inbound: Asana  →  Timesheet (full sync + webhook handler)
// ============================================================================

export async function runAsanaFullSync(
  context: IntegrationContext<AsanaConfig>
): Promise<AsanaSyncResult> {
  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  const allowInbound = syncDirection !== 'timesheet-to-asana' && syncDirection !== 'timesheet-to-external';

  const projectMappings = await context.mappings.list({ system: SYSTEM, entity: PROJECT_ENTITY });
  if (projectMappings.length === 0) {
    return skip({ reason: 'missing-project-mappings' });
  }

  if (!allowInbound) {
    return {
      system: SYSTEM,
      status: 'completed',
      syncedCount: 0,
      details: { syncDirection, reason: 'outbound-only' }
    };
  }

  const projectByExternalId = new Map(projectMappings.map((m) => [m.externalId, m.localId]));

  const lastSyncTime = (await context.state.get<string>(SYNC_STATE_KEY)) ?? undefined;
  const startedAt = new Date().toISOString();
  const client = createAsanaClient(context);

  let syncedCount = 0;
  for (const mapping of projectMappings) {
    if (!mapping.externalId) continue;
    const asanaTasks = await client.listTasksInProject(mapping.externalId, lastSyncTime);
    for (const asanaTask of asanaTasks) {
      const synced = await upsertLocalTodoFromAsanaTask(context, asanaTask, projectByExternalId);
      if (synced) syncedCount += 1;
    }
  }

  await context.state.set(SYNC_STATE_KEY, startedAt);

  return {
    system: SYSTEM,
    status: 'completed',
    syncedCount,
    details: { syncDirection, sinceIso: lastSyncTime ?? null, mappedProjects: projectMappings.length }
  };
}

export async function handleAsanaWebhook(
  input: SyncInput,
  context: IntegrationContext<AsanaConfig>
): Promise<AsanaSyncResult> {
  // Asana webhook handshake: persist the secret on first POST so subsequent
  // X-Hook-Signature checks pass. The runtime echoes the header back in the
  // HTTP response.
  const handshakeSecret = getHeader(input, 'x-hook-secret');
  if (handshakeSecret) {
    await context.state.set('asana:webhook-secret', handshakeSecret);
    return { system: SYSTEM, status: 'handshake', syncedCount: 0, details: { hasSecret: true } };
  }

  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  if (syncDirection === 'timesheet-to-asana' || syncDirection === 'timesheet-to-external') {
    return skip({ reason: 'sync-direction-mismatch' });
  }

  const storedSecret = (await context.state.get<string>('asana:webhook-secret')) ?? context.config?.webhookSecret;
  const signature = getHeader(input, 'x-hook-signature');
  const rawBody = getRawBody(input);

  if (storedSecret) {
    if (!signature || !rawBody) {
      return { system: SYSTEM, status: 'rejected', syncedCount: 0, details: { reason: 'missing-signature-or-body' } };
    }
    if (!(await verifyAsanaSignature(rawBody, signature, storedSecret))) {
      context.logger.warn('Asana webhook rejected: signature mismatch');
      return { system: SYSTEM, status: 'rejected', syncedCount: 0, details: { reason: 'invalid-signature' } };
    }
  }

  const payload = parseWebhookPayload(input.body, rawBody);
  const events = payload?.events ?? [];
  if (events.length === 0) {
    return { system: SYSTEM, status: 'ignored', syncedCount: 0, details: { reason: 'no-events' } };
  }

  const taskGids = new Set<string>();
  const deletedTaskGids = new Set<string>();
  const entryGids = new Set<string>();
  const deletedEntryGids = new Set<string>();

  for (const event of events) {
    const resourceType = event?.resource?.resource_type;
    const gid = event?.resource?.gid;
    const action = event.action ?? 'changed';
    if (!gid) continue;
    if (resourceType === 'task') {
      if (action === 'deleted' || action === 'removed') {
        deletedTaskGids.add(gid);
      } else {
        taskGids.add(gid);
      }
    } else if (resourceType === 'time_tracking_entry') {
      if (action === 'deleted' || action === 'removed') {
        deletedEntryGids.add(gid);
      } else {
        entryGids.add(gid);
      }
    }
  }

  return processInboundChanges(context, {
    taskGids,
    deletedTaskGids,
    entryGids,
    deletedEntryGids
  });
}

export async function syncTodoFromAsana(
  input: SyncInput,
  context: IntegrationContext<AsanaConfig>
): Promise<AsanaSyncResult> {
  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  if (syncDirection === 'timesheet-to-asana' || syncDirection === 'timesheet-to-external') {
    return skip({ reason: 'sync-direction-mismatch' });
  }
  const externalTaskId = input?.externalTaskId;
  if (!externalTaskId) {
    return skip({ reason: 'missing-external-task-id' });
  }
  return processInboundChanges(context, {
    taskGids: new Set([externalTaskId]),
    deletedTaskGids: new Set(),
    entryGids: new Set(),
    deletedEntryGids: new Set()
  });
}

interface InboundChangeSet {
  taskGids: Set<string>;
  deletedTaskGids: Set<string>;
  entryGids: Set<string>;
  deletedEntryGids: Set<string>;
}

async function processInboundChanges(
  context: IntegrationContext<AsanaConfig>,
  changes: InboundChangeSet
): Promise<AsanaSyncResult> {
  const totalEvents =
    changes.taskGids.size + changes.deletedTaskGids.size + changes.entryGids.size + changes.deletedEntryGids.size;
  if (totalEvents === 0) {
    return { system: SYSTEM, status: 'ignored', syncedCount: 0, details: { reason: 'no-changes' } };
  }

  const projectMappings = await context.mappings.list({ system: SYSTEM, entity: PROJECT_ENTITY });
  const projectByExternalId = new Map(projectMappings.map((m) => [m.externalId, m.localId]));

  const client = getOrCreateClient(context);
  let syncedCount = 0;

  // 1) Asana task deletes → delete the local todo.
  for (const gid of changes.deletedTaskGids) {
    const removed = await deleteLocalTodoByExternalId(context, gid);
    if (removed) syncedCount += 1;
  }

  // 2) Asana task changes → upsert the local todo.
  for (const gid of changes.taskGids) {
    const asanaTask = await client.getTask(gid);
    if (!asanaTask) {
      const removed = await deleteLocalTodoByExternalId(context, gid);
      if (removed) syncedCount += 1;
      continue;
    }
    const synced = await upsertLocalTodoFromAsanaTask(context, asanaTask, projectByExternalId);
    if (synced) syncedCount += 1;
  }

  // 3) Time-entry deletes → delete the local task.
  for (const gid of changes.deletedEntryGids) {
    const removed = await deleteLocalTaskByExternalId(context, gid);
    if (removed) syncedCount += 1;
  }

  // 4) Time-entry changes → upsert the local task.
  for (const gid of changes.entryGids) {
    const entry = await client.getTimeTrackingEntry(gid);
    if (!entry) {
      const removed = await deleteLocalTaskByExternalId(context, gid);
      if (removed) syncedCount += 1;
      continue;
    }
    const synced = await upsertLocalTaskFromAsanaEntry(context, entry);
    if (synced) syncedCount += 1;
  }

  return {
    system: SYSTEM,
    status: 'completed',
    syncedCount,
    details: {
      taskEvents: changes.taskGids.size,
      taskDeletes: changes.deletedTaskGids.size,
      entryEvents: changes.entryGids.size,
      entryDeletes: changes.deletedEntryGids.size
    }
  };
}

async function upsertLocalTodoFromAsanaTask(
  context: IntegrationContext<AsanaConfig>,
  asanaTask: AsanaTask,
  projectByExternalId: Map<string, string>
): Promise<boolean> {
  if (!asanaTask?.gid) return false;

  const localProjectId = (asanaTask.projects ?? [])
    .map((p) => p?.gid)
    .filter((gid): gid is string => !!gid)
    .map((gid) => projectByExternalId.get(gid))
    .find((id): id is string => !!id);
  if (!localProjectId) {
    return false;
  }

  const todoMapping = await context.mappings.findByExternal({
    system: SYSTEM,
    entity: TODO_ENTITY,
    externalId: asanaTask.gid
  });

  const name = asanaTask.name?.trim() || `Asana task ${asanaTask.gid}`;
  const description = asanaTask.notes?.trim() || undefined;
  const status = asanaTask.completed ? TODO_STATUS_CLOSED : TODO_STATUS_OPEN;
  const dueDate = asanaTask.due_on ?? (asanaTask.due_at ? asanaTask.due_at.slice(0, 10) : undefined);

  if (!todoMapping?.localId) {
    // Import lock: a webhook delivery racing a full sync must not create the
    // same todo twice. Held for the TTL; released only when the create fails.
    const lockKey = `import:todo:${asanaTask.gid}`;
    if (!(await tryAcquireStateLock(context.state, lockKey, IMPORT_LOCK_TTL_SECONDS))) {
      context.logger.info('Asana todo import already in progress, skipping duplicate create', {
        externalId: asanaTask.gid
      });
      return false;
    }

    let created: ToDoDto;
    try {
      created = await context.data.createTodo({
        projectId: localProjectId,
        name,
        description,
        status,
        dueDate
      } as ToDoCreateInput);
    } catch (err) {
      await releaseStateLock(context.state, lockKey);
      throw err;
    }

    await context.mappings.upsert({
      system: SYSTEM,
      entity: TODO_ENTITY,
      localId: created.id,
      externalId: asanaTask.gid,
      externalLabel: name,
      metadata: {
        projectId: asanaTask.projects?.[0]?.gid ?? '',
        localProjectId,
        ...syncMetadataStamp({
          localLastUpdateMillis: getLastUpdateMillis(created),
          externalUpdatedAt: asanaTask.modified_at,
          externalUpdatedKey: 'modifiedAt'
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
    metadataKey: 'modifiedAt',
    externalUpdatedAt: asanaTask.modified_at
  })) {
    return false;
  }

  const existing = await context.data.getTodo(todoMapping.localId);
  if (isStaleExternalChange({
    externalUpdatedAt: asanaTask.modified_at,
    localLastUpdateMillis: getLastUpdateMillis(existing)
  })) {
    return false;
  }

  const updated = await context.data.updateTodo(todoMapping.localId, {
    name,
    description,
    status,
    dueDate
  } as ToDoUpdateInput);

  await context.mappings.upsert({
    system: SYSTEM,
    entity: TODO_ENTITY,
    localId: todoMapping.localId,
    externalId: asanaTask.gid,
    externalLabel: name,
    metadata: {
      projectId: asanaTask.projects?.[0]?.gid ?? '',
      localProjectId,
      ...syncMetadataStamp({
        localLastUpdateMillis: getLastUpdateMillis(updated),
        externalUpdatedAt: asanaTask.modified_at,
        externalUpdatedKey: 'modifiedAt'
      })
    },
    syncStatus: 'SYNCED'
  });
  return true;
}

async function upsertLocalTaskFromAsanaEntry(
  context: IntegrationContext<AsanaConfig>,
  entry: AsanaTimeTrackingEntry
): Promise<boolean> {
  const asanaTaskGid = entry.task?.gid;
  if (!asanaTaskGid) return false;

  const todoMapping = await context.mappings.findByExternal({
    system: SYSTEM,
    entity: TODO_ENTITY,
    externalId: asanaTaskGid
  });
  if (!todoMapping?.localId) {
    // The parent Asana task isn't synced as a Timesheet todo yet — nothing to attach to.
    return false;
  }

  const localProjectId = readMetadataString(todoMapping.metadata ?? {}, 'localProjectId');
  if (!localProjectId) {
    return false;
  }

  const dateRange = entryToTaskDateRange(entry);
  if (!dateRange) return false;

  const description = `Time logged in Asana (${entry.duration_minutes ?? 0}m)`;

  const taskMapping = await context.mappings.findByExternal({
    system: SYSTEM,
    entity: TASK_ENTITY,
    externalId: entry.gid
  });

  if (!taskMapping?.localId) {
    // Import lock: a webhook delivery racing a full sync must not create the
    // same task twice. Held for the TTL; released only when the create fails.
    const lockKey = `import:task:${entry.gid}`;
    if (!(await tryAcquireStateLock(context.state, lockKey, IMPORT_LOCK_TTL_SECONDS))) {
      context.logger.info('Asana entry import already in progress, skipping duplicate create', {
        externalId: entry.gid
      });
      return false;
    }

    let created: TaskDto;
    try {
      created = await context.data.createTask({
        projectId: localProjectId,
        todoId: todoMapping.localId,
        startDateTime: dateRange.startDateTime,
        endDateTime: dateRange.endDateTime,
        description
      } as TaskCreateInput);
    } catch (err) {
      await releaseStateLock(context.state, lockKey);
      throw err;
    }

    await context.mappings.upsert({
      system: SYSTEM,
      entity: TASK_ENTITY,
      localId: created.id,
      externalId: entry.gid,
      externalLabel: description,
      metadata: {
        asanaTaskGid,
        todoId: todoMapping.localId,
        durationMinutes: String(entry.duration_minutes ?? 0),
        enteredOn: entry.entered_on ?? '',
        ...syncMetadataStamp({ localLastUpdateMillis: getLastUpdateMillis(created) })
      },
      syncStatus: 'SYNCED'
    });
    return true;
  }

  const existing = await context.data.getTask(taskMapping.localId);
  // Entries expose no modified timestamp — created_at vs the task's own
  // lastUpdate is the only staleness signal available.
  if (isStaleExternalChange({
    externalUpdatedAt: entry.created_at,
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
    externalId: entry.gid,
    externalLabel: description,
    metadata: {
      asanaTaskGid,
      todoId: todoMapping.localId,
      durationMinutes: String(entry.duration_minutes ?? 0),
      enteredOn: entry.entered_on ?? '',
      ...syncMetadataStamp({ localLastUpdateMillis: getLastUpdateMillis(updated) })
    },
    syncStatus: 'SYNCED'
  });
  return true;
}

async function deleteLocalTodoByExternalId(
  context: IntegrationContext<AsanaConfig>,
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
    context.logger.warn('Failed to delete local todo for Asana task delete', {
      localId: mapping.localId,
      externalId,
      error: String(err)
    });
  }
  await context.mappings.delete({ system: SYSTEM, entity: TODO_ENTITY, localId: mapping.localId });
  return true;
}

async function deleteLocalTaskByExternalId(
  context: IntegrationContext<AsanaConfig>,
  externalId: string
): Promise<boolean> {
  const mapping = await context.mappings.findByExternal({
    system: SYSTEM,
    entity: TASK_ENTITY,
    externalId
  });
  if (!mapping?.localId) return false;
  try {
    await context.data.deleteTask(mapping.localId);
  } catch (err) {
    context.logger.warn('Failed to delete local task for Asana entry delete', {
      localId: mapping.localId,
      externalId,
      error: String(err)
    });
  }
  await context.mappings.delete({ system: SYSTEM, entity: TASK_ENTITY, localId: mapping.localId });
  return true;
}

// ============================================================================
// Helpers
// ============================================================================

async function getMapping(
  context: IntegrationContext<AsanaConfig>,
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
  context: IntegrationContext<AsanaConfig>
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
  context: IntegrationContext<AsanaConfig>
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

function buildAsanaTaskPayloadFromTodo(todo: ToDoDto): Record<string, unknown> {
  const name = todo.name?.trim() || `Todo ${todo.id}`;
  const notes = todo.description ?? '';
  const completed = todo.status === TODO_STATUS_CLOSED;
  const payload: Record<string, unknown> = {
    name,
    notes,
    completed
  };
  if (todo.dueDate) {
    // Asana expects ISO date (YYYY-MM-DD) for due_on; full datetime for due_at.
    payload.due_on = todo.dueDate.length > 10 ? todo.dueDate.slice(0, 10) : todo.dueDate;
  }
  return payload;
}

function computeDurationMinutes(task: TaskDto): number | null {
  // task.duration and task.durationBreak are in seconds; Asana wants whole
  // minutes, so net worked seconds convert with a /60 divisor.
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

function toEnteredOn(value: string | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function entryToTaskDateRange(entry: AsanaTimeTrackingEntry): { startDateTime: string; endDateTime: string } | null {
  if (!entry.entered_on) return null;
  const start = new Date(`${entry.entered_on}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return null;
  const duration = Number(entry.duration_minutes ?? 0);
  if (!Number.isFinite(duration) || duration < 0) return null;
  const end = new Date(start.getTime() + duration * 60_000);
  return { startDateTime: start.toISOString(), endDateTime: end.toISOString() };
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
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
  if (!key) return undefined;
  const value = headers[key];
  return value === undefined || value === null ? undefined : String(value);
}

function getRawBody(input: SyncInput): string | undefined {
  if (typeof input?.rawBody === 'string' && input.rawBody.length > 0) return input.rawBody;
  if (typeof input?.body === 'string' && input.body.length > 0) return input.body;
  if (input?.body && typeof input.body === 'object') {
    try {
      return JSON.stringify(input.body);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseWebhookPayload(body: unknown, rawBody: string | undefined): AsanaWebhookPayload | null {
  if (body && typeof body === 'object') return body as AsanaWebhookPayload;
  if (rawBody) {
    try {
      return JSON.parse(rawBody) as AsanaWebhookPayload;
    } catch {
      return null;
    }
  }
  return null;
}

// Web Crypto is used so this plugin works in sandboxed runtimes (esbuild bundler
// without Node built-ins). Both Node 18+ and the plugin runtime expose
// `globalThis.crypto.subtle`.
async function verifyAsanaSignature(rawBody: string, signatureHeader: string, secret: string): Promise<boolean> {
  // Asana signs the raw request body with HMAC-SHA256 keyed on the webhook
  // secret, and sends the digest as lowercase hex in `x-hook-signature`.
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const expected = bufferToHex(signatureBuffer);
  return constantTimeEquals(expected, signatureHeader);
}

function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
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

function readMetadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  if (typeof value === 'string' && value.trim().length > 0) return value;
  return undefined;
}

function skip(details: Record<string, unknown>): AsanaSyncResult {
  return { system: SYSTEM, status: 'skipped', syncedCount: 0, details };
}
