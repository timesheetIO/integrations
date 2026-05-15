import {
  IntegrationContext,
  MappingRecord,
  TaskCreateInput,
  TaskDto,
  TaskUpdateInput,
  ToDoCreateInput,
  ToDoDto,
  ToDoUpdateInput
} from '@timesheet/integration-sdk';
import { ClickUpClient } from './clickupClient';
import {
  ClickUpConfig,
  ClickUpTask,
  ClickUpTimeEntry,
  ClickUpWebhookPayload,
  SyncInput
} from './types';

const SYSTEM = 'clickup';
const PROJECT_ENTITY = 'project';
const USER_ENTITY = 'user';
const TASK_ENTITY = 'task';
const TODO_ENTITY = 'todo';
const SYNC_STATE_KEY = 'clickup:last-sync-time';

export interface ClickUpSyncResult {
  system: string;
  status: string;
  syncedCount: number;
  details?: Record<string, unknown>;
}

export interface SyncBatchCaches {
  projectMappingByLocalId?: Map<string, MappingRecord>;
  taskMappingByLocalId?: Map<string, MappingRecord>;
  todoMappingByLocalId?: Map<string, MappingRecord>;
  userMappingByLocalId?: Map<string, MappingRecord>;
}

let sharedClient: ClickUpClient | null = null;

export function resetSharedClient(): void {
  sharedClient = null;
}

export function createClickUpClient(context: IntegrationContext<ClickUpConfig>): ClickUpClient {
  return new ClickUpClient({
    getAccessToken: () => context.credentials.getAccessToken(SYSTEM),
    refreshAccessToken: () => context.credentials.refreshToken(SYSTEM)
  });
}

function getOrCreateClient(context: IntegrationContext<ClickUpConfig>): ClickUpClient {
  if (!sharedClient) {
    sharedClient = createClickUpClient(context);
  }
  return sharedClient;
}

// ---------------------------------------------------------------------------
// Outbound: Timesheet ToDo → ClickUp Task
// ---------------------------------------------------------------------------

export async function syncTodoToClickUp(
  input: SyncInput,
  context: IntegrationContext<ClickUpConfig>,
  caches?: SyncBatchCaches
): Promise<ClickUpSyncResult> {
  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  if (syncDirection === 'clickup-to-timesheet' || syncDirection === 'external-to-timesheet') {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'sync-direction-mismatch' } };
  }

  const todoId = resolveTodoId(input);
  if (!todoId) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'missing-todo-id' } };
  }

  const todo = await loadTodo(todoId, input, context);
  if (!todo) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'todo-not-found', todoId } };
  }

  const projectId = todo.project?.id;
  if (!projectId) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'missing-project', todoId } };
  }

  const projectMapping = await getMapping(context, caches?.projectMappingByLocalId, PROJECT_ENTITY, projectId);
  if (!projectMapping?.externalId) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'missing-project-mapping', projectId } };
  }

  const listId = extractListId(projectMapping.externalId);
  if (!listId) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'invalid-list-mapping' } };
  }

  const client = getOrCreateClient(context);
  const todoMapping = await getMapping(context, caches?.todoMappingByLocalId, TODO_ENTITY, todo.id);

  if (todo.deleted) {
    if (todoMapping?.externalId) {
      await client.deleteTask(todoMapping.externalId);
      await context.mappings.delete({
        system: SYSTEM,
        entity: TODO_ENTITY,
        localId: todo.id
      });
      caches?.todoMappingByLocalId?.delete(todo.id);
      return { system: SYSTEM, status: 'deleted', syncedCount: 1 };
    }
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'already-deleted' } };
  }

  const payload = buildClickUpTaskPayload(todo);

  let external: ClickUpTask;
  if (todoMapping?.externalId) {
    try {
      external = await client.updateTask(todoMapping.externalId, payload);
    } catch (err) {
      if (String(err).includes('(404)')) {
        external = await client.createTask(listId, payload);
      } else {
        throw err;
      }
    }
  } else {
    external = await client.createTask(listId, payload);
  }

  if (!external?.id) {
    return { system: SYSTEM, status: 'failed', syncedCount: 0, details: { reason: 'missing-external-id' } };
  }

  const upsertedMapping: MappingRecord = {
    localId: todo.id,
    externalId: external.id,
    externalLabel: external.name ?? todo.name,
    metadata: {
      listId,
      dateUpdated: external.date_updated ?? '',
      url: external.url ?? ''
    },
    syncStatus: 'SYNCED'
  };

  await context.mappings.upsert({
    system: SYSTEM,
    entity: TODO_ENTITY,
    ...upsertedMapping
  });

  caches?.todoMappingByLocalId?.set(todo.id, upsertedMapping);

  return {
    system: SYSTEM,
    status: 'synced',
    syncedCount: 1,
    details: { todoId: todo.id, externalTaskId: external.id }
  };
}

// ---------------------------------------------------------------------------
// Outbound: Timesheet Task → ClickUp Time Entry
// ---------------------------------------------------------------------------

export async function syncTaskToClickUp(
  input: SyncInput,
  context: IntegrationContext<ClickUpConfig>,
  caches?: SyncBatchCaches
): Promise<ClickUpSyncResult> {
  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  if (syncDirection === 'clickup-to-timesheet' || syncDirection === 'external-to-timesheet') {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'sync-direction-mismatch' } };
  }

  const taskId = resolveTaskId(input);
  if (!taskId) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'missing-task-id' } };
  }

  const task = await loadTask(taskId, input, context);
  if (!task) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'task-not-found', taskId } };
  }

  if (task.running) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'task-running', taskId } };
  }

  const projectId = task.project?.id;
  if (!projectId) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'missing-project', taskId } };
  }

  const projectMapping = await getMapping(context, caches?.projectMappingByLocalId, PROJECT_ENTITY, projectId);
  if (!projectMapping?.externalId) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'missing-project-mapping', projectId } };
  }

  const teamId = extractTeamId(projectMapping.externalId);
  if (!teamId) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'missing-team-id' } };
  }

  const client = getOrCreateClient(context);
  const taskMapping = await getMapping(context, caches?.taskMappingByLocalId, TASK_ENTITY, task.id);

  if (task.deleted) {
    if (taskMapping?.externalId) {
      await client.deleteTimeEntry(teamId, taskMapping.externalId);
      await context.mappings.delete({
        system: SYSTEM,
        entity: TASK_ENTITY,
        localId: task.id
      });
      caches?.taskMappingByLocalId?.delete(task.id);
      return { system: SYSTEM, status: 'deleted', syncedCount: 1 };
    }
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'already-deleted' } };
  }

  let payload: Record<string, unknown>;
  try {
    payload = buildClickUpTimeEntryPayload(task);
  } catch (err) {
    context.logger.warn('Failed to build ClickUp time entry payload', { taskId: task.id, error: String(err) });
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'invalid-task-data', taskId: task.id } };
  }

  // Attach the time entry to the mapped ClickUp task if the Timesheet task
  // links to a ToDo we've already synced. Otherwise it lands at the workspace
  // level (still visible in ClickUp time reports, just unattached).
  const todoId = task.todo?.id;
  if (todoId) {
    const todoMapping = await getMapping(context, caches?.todoMappingByLocalId, TODO_ENTITY, todoId);
    if (todoMapping?.externalId) {
      payload.tid = todoMapping.externalId;
    }
  }

  // Attribute the time entry to the mapped ClickUp user when available. ClickUp
  // ignores `assignee` on Free plans and falls back to the OAuth account; we
  // still send it so paid workspaces get the correct attribution.
  const localUserId = task.user ?? task.member?.uid;
  if (localUserId) {
    const userMapping = await getMapping(context, caches?.userMappingByLocalId, USER_ENTITY, localUserId);
    if (userMapping?.externalId) {
      const assigneeId = Number(userMapping.externalId);
      payload.assignee = Number.isFinite(assigneeId) ? assigneeId : userMapping.externalId;
    }
  }

  let external: ClickUpTimeEntry;
  if (taskMapping?.externalId) {
    try {
      external = await client.updateTimeEntry(teamId, taskMapping.externalId, payload);
    } catch (err) {
      if (String(err).includes('(404)')) {
        external = await client.createTimeEntry(teamId, payload);
      } else {
        throw err;
      }
    }
  } else {
    external = await client.createTimeEntry(teamId, payload);
  }

  if (!external?.id) {
    return { system: SYSTEM, status: 'failed', syncedCount: 0, details: { reason: 'missing-external-id' } };
  }

  const upsertedMapping: MappingRecord = {
    localId: task.id,
    externalId: external.id,
    externalLabel: task.description ?? task.id,
    metadata: {
      teamId,
      tid: payload.tid ? String(payload.tid) : '',
      updatedAt: external.at ? String(external.at) : ''
    },
    syncStatus: 'SYNCED'
  };

  await context.mappings.upsert({
    system: SYSTEM,
    entity: TASK_ENTITY,
    ...upsertedMapping
  });

  caches?.taskMappingByLocalId?.set(task.id, upsertedMapping);

  return {
    system: SYSTEM,
    status: 'synced',
    syncedCount: 1,
    details: { taskId: task.id, externalTimeEntryId: external.id }
  };
}

// ---------------------------------------------------------------------------
// Full sync (inbound)
// ---------------------------------------------------------------------------

export async function runClickUpFullSync(
  context: IntegrationContext<ClickUpConfig>
): Promise<ClickUpSyncResult> {
  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  const allowInbound = syncDirection !== 'timesheet-to-clickup' && syncDirection !== 'timesheet-to-external';

  const projectMappings = await context.mappings.list({ system: SYSTEM, entity: PROJECT_ENTITY });
  if (projectMappings.length === 0) {
    return {
      system: SYSTEM,
      status: 'skipped',
      syncedCount: 0,
      details: { reason: 'missing-project-mappings' }
    };
  }

  if (!allowInbound) {
    return {
      system: SYSTEM,
      status: 'completed',
      syncedCount: 0,
      details: { syncDirection, reason: 'outbound-only' }
    };
  }

  const client = getOrCreateClient(context);
  // Coerce defensively — the runtime has occasionally been observed handing
  // back wrapper objects instead of the raw number we stored. Anything that
  // isn't a finite positive epoch-ms value falls through to a full resync.
  const rawSince = await context.state.get<unknown>(SYNC_STATE_KEY);
  const sinceMs = typeof rawSince === 'number' && Number.isFinite(rawSince) && rawSince > 0
    ? rawSince
    : undefined;
  const startedAt = Date.now();
  let syncedCount = 0;

  for (const mapping of projectMappings) {
    const listId = extractListId(mapping.externalId);
    if (!listId) {
      continue;
    }
    const tasks = await client.listTasksForList(listId, { dateUpdatedGt: sinceMs });
    for (const task of tasks) {
      const synced = await syncSingleExternalTask(context, mapping, task);
      if (synced) {
        syncedCount += 1;
      }
    }
  }

  await context.state.set(SYNC_STATE_KEY, startedAt);

  return {
    system: SYSTEM,
    status: 'completed',
    syncedCount,
    details: { syncDirection, sinceMs: sinceMs ?? null, listCount: projectMappings.length }
  };
}

// ---------------------------------------------------------------------------
// Inbound webhook: ClickUp Task events → Timesheet ToDos
// ---------------------------------------------------------------------------

export async function handleClickUpWebhook(
  input: SyncInput,
  context: IntegrationContext<ClickUpConfig>
): Promise<ClickUpSyncResult> {
  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  if (syncDirection === 'timesheet-to-clickup' || syncDirection === 'timesheet-to-external') {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'sync-direction-mismatch' } };
  }

  const secret = context.config?.webhookSecret;
  if (!secret) {
    context.logger.warn('ClickUp webhook rejected: webhookSecret not configured');
    return { system: SYSTEM, status: 'rejected', syncedCount: 0, details: { reason: 'secret-not-configured' } };
  }

  const signature = getHeader(input, 'x-signature');
  if (!signature) {
    return { system: SYSTEM, status: 'rejected', syncedCount: 0, details: { reason: 'missing-signature' } };
  }

  const rawBody = getRawBody(input);
  if (!rawBody) {
    return { system: SYSTEM, status: 'rejected', syncedCount: 0, details: { reason: 'missing-body' } };
  }

  if (!(await verifyClickUpSignature(rawBody, signature, secret))) {
    context.logger.warn('ClickUp webhook rejected: signature mismatch');
    return { system: SYSTEM, status: 'rejected', syncedCount: 0, details: { reason: 'invalid-signature' } };
  }

  const payload = parseWebhookPayload(input.body, rawBody);
  const taskId = payload?.task_id;
  const event = (payload?.event ?? '').toLowerCase();

  if (!taskId) {
    return { system: SYSTEM, status: 'ignored', syncedCount: 0, details: { reason: 'no-task-id' } };
  }

  if (event === 'taskdeleted') {
    const removed = await deleteLocalTodoByExternalId(context, taskId);
    return {
      system: SYSTEM,
      status: removed ? 'completed' : 'ignored',
      syncedCount: removed ? 1 : 0,
      details: { event, taskId }
    };
  }

  const client = getOrCreateClient(context);
  const externalTask = await client.getTask(taskId);
  if (!externalTask) {
    return { system: SYSTEM, status: 'ignored', syncedCount: 0, details: { reason: 'task-not-found', taskId } };
  }

  const projectMapping = await findProjectMappingForTask(context, externalTask);
  if (!projectMapping) {
    return { system: SYSTEM, status: 'ignored', syncedCount: 0, details: { reason: 'no-matching-project-mapping', taskId } };
  }

  const synced = await syncSingleExternalTask(context, projectMapping, externalTask);
  return {
    system: SYSTEM,
    status: 'completed',
    syncedCount: synced ? 1 : 0,
    details: { event, taskId }
  };
}

export async function syncTaskFromClickUp(
  input: SyncInput,
  context: IntegrationContext<ClickUpConfig>
): Promise<ClickUpSyncResult> {
  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  if (syncDirection === 'timesheet-to-clickup' || syncDirection === 'timesheet-to-external') {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'sync-direction-mismatch' } };
  }

  const externalTaskId = input?.externalTaskId;
  if (!externalTaskId) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'missing-external-task-id' } };
  }

  const client = getOrCreateClient(context);
  const externalTask = await client.getTask(externalTaskId);
  if (!externalTask) {
    return { system: SYSTEM, status: 'ignored', syncedCount: 0, details: { reason: 'task-not-found', externalTaskId } };
  }

  const projectMapping = await findProjectMappingForTask(context, externalTask);
  if (!projectMapping) {
    return { system: SYSTEM, status: 'ignored', syncedCount: 0, details: { reason: 'no-matching-project-mapping' } };
  }

  const synced = await syncSingleExternalTask(context, projectMapping, externalTask);
  return {
    system: SYSTEM,
    status: 'completed',
    syncedCount: synced ? 1 : 0,
    details: { externalTaskId }
  };
}

// Maps an inbound ClickUp task to a Timesheet ToDo (create or update).
async function syncSingleExternalTask(
  context: IntegrationContext<ClickUpConfig>,
  projectMapping: MappingRecord,
  external: ClickUpTask
): Promise<boolean> {
  if (!external?.id) {
    return false;
  }

  const todoMapping = await context.mappings.findByExternal({
    system: SYSTEM,
    entity: TODO_ENTITY,
    externalId: external.id
  });

  const name = external.name?.trim() || external.id;
  const description = external.text_content ?? external.description ?? '';
  const dueDateMs = parseClickUpDate(external.due_date);
  const dueDate = dueDateMs ? new Date(dueDateMs).toISOString() : undefined;
  const status = mapClickUpStatusToLocal(external.status?.type);

  if (!todoMapping?.localId) {
    const created = await context.data.createTodo({
      projectId: projectMapping.localId,
      name,
      description,
      dueDate,
      status
    } as ToDoCreateInput);

    await context.mappings.upsert({
      system: SYSTEM,
      entity: TODO_ENTITY,
      localId: created.id,
      externalId: external.id,
      externalLabel: external.name ?? external.id,
      metadata: {
        listId: extractListId(projectMapping.externalId) ?? '',
        dateUpdated: external.date_updated ?? '',
        url: external.url ?? ''
      },
      syncStatus: 'SYNCED'
    });

    return true;
  }

  const existing = await context.data.getTodo(todoMapping.localId);
  const externalUpdatedAt = external.date_updated ? Number(external.date_updated) : 0;
  if (existing?.lastUpdate && externalUpdatedAt > 0 && externalUpdatedAt <= existing.lastUpdate) {
    return false;
  }

  await context.data.updateTodo(todoMapping.localId, {
    name,
    description,
    dueDate,
    status
  } as ToDoUpdateInput);

  await context.mappings.upsert({
    system: SYSTEM,
    entity: TODO_ENTITY,
    localId: todoMapping.localId,
    externalId: external.id,
    externalLabel: external.name ?? external.id,
    metadata: {
      listId: extractListId(projectMapping.externalId) ?? '',
      dateUpdated: external.date_updated ?? '',
      url: external.url ?? ''
    },
    syncStatus: 'SYNCED'
  });

  return true;
}

async function deleteLocalTodoByExternalId(
  context: IntegrationContext<ClickUpConfig>,
  externalId: string
): Promise<boolean> {
  const mapping = await context.mappings.findByExternal({
    system: SYSTEM,
    entity: TODO_ENTITY,
    externalId
  });
  if (!mapping?.localId) {
    return false;
  }
  try {
    await context.data.deleteTodo(mapping.localId);
  } catch (err) {
    context.logger.warn('Failed to delete local todo for ClickUp delete event', {
      localId: mapping.localId,
      externalId,
      error: String(err)
    });
  }
  await context.mappings.delete({
    system: SYSTEM,
    entity: TODO_ENTITY,
    localId: mapping.localId
  });
  return true;
}

async function findProjectMappingForTask(
  context: IntegrationContext<ClickUpConfig>,
  external: ClickUpTask
): Promise<MappingRecord | null> {
  const listId = external.list?.id;
  if (!listId) {
    return null;
  }
  const projectMappings = await context.mappings.list({ system: SYSTEM, entity: PROJECT_ENTITY });
  return projectMappings.find((mapping) => extractListId(mapping.externalId) === listId) ?? null;
}

async function getMapping(
  context: IntegrationContext<ClickUpConfig>,
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
  context: IntegrationContext<ClickUpConfig>
): Promise<TaskDto | null> {
  if (input?.item && typeof input.item === 'object' && (input.item.id || input.item.taskId)) {
    const raw = input.item as Record<string, unknown>;
    const projectId = raw.projectId as string | undefined;
    if (!raw.project && projectId) {
      raw.project = { id: projectId };
    }
    const todoId = raw.todoId as string | undefined;
    if (!raw.todo && todoId) {
      raw.todo = { id: todoId };
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

async function loadTodo(
  todoId: string,
  input: SyncInput,
  context: IntegrationContext<ClickUpConfig>
): Promise<ToDoDto | null> {
  if (input?.item && typeof input.item === 'object' && (input.item.id || input.item.todoId)) {
    const raw = input.item as Record<string, unknown>;
    const projectId = raw.projectId as string | undefined;
    if (!raw.project && projectId) {
      raw.project = { id: projectId };
    }
    if (!raw.id && raw.todoId) {
      raw.id = raw.todoId;
    }
    return raw as unknown as ToDoDto;
  }
  try {
    return await context.data.getTodo(todoId);
  } catch {
    return null;
  }
}

function resolveTaskId(input: SyncInput): string | undefined {
  return input?.taskId || input?.item?.taskId || input?.item?.id;
}

function resolveTodoId(input: SyncInput): string | undefined {
  return input?.todoId || input?.item?.todoId || input?.item?.id;
}

function buildClickUpTimeEntryPayload(task: TaskDto): Record<string, unknown> {
  const start = parseDate(task.startDateTime);
  const end = parseDate(task.endDateTime);

  if (!start || !end) {
    throw new Error(`Task ${task.id} is missing start or end datetime.`);
  }

  const duration = Math.max(0, end.getTime() - start.getTime());

  const payload: Record<string, unknown> = {
    description: task.description ?? '',
    start: start.getTime(),
    duration,
    billable: task.billable === true
  };

  if (task.tags && task.tags.length > 0) {
    payload.tags = task.tags
      .filter((tag) => !!tag?.name)
      .map((tag) => ({ name: tag.name }));
  }

  return payload;
}

function buildClickUpTaskPayload(todo: ToDoDto): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: todo.name?.trim() || `Timesheet todo ${todo.id}`,
    description: todo.description ?? ''
  };

  if (todo.dueDate) {
    const due = parseDate(todo.dueDate);
    if (due) {
      payload.due_date = due.getTime();
      payload.due_date_time = true;
    }
  }

  // Timesheet ToDo status is a numeric flag (0 = open, 1 = closed). Translate to
  // ClickUp's named statuses; the workspace may rename these, in which case we
  // fall back to "open" / "closed" and let the user adjust their workflow.
  if (typeof todo.status === 'number') {
    payload.status = todo.status === 1 ? 'closed' : 'open';
  }

  const estimateMs = ((todo.estimatedHours ?? 0) * 60 + (todo.estimatedMinutes ?? 0)) * 60_000;
  if (estimateMs > 0) {
    payload.time_estimate = estimateMs;
  }

  return payload;
}

function parseClickUpDate(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseDate(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function mapClickUpStatusToLocal(statusType: string | undefined): number | undefined {
  if (!statusType) {
    return undefined;
  }
  // ClickUp groups statuses into "open", "custom", "closed", "done". Anything
  // that isn't explicitly "closed" / "done" maps to Timesheet's open state.
  const normalized = statusType.toLowerCase();
  return normalized === 'closed' || normalized === 'done' ? 1 : 0;
}

function extractListId(externalId: string | undefined): string | null {
  if (!externalId) {
    return null;
  }
  const idx = externalId.indexOf(':');
  return idx >= 0 ? externalId.slice(idx + 1) : externalId;
}

function extractTeamId(externalId: string | undefined): string | null {
  if (!externalId) {
    return null;
  }
  const idx = externalId.indexOf(':');
  return idx >= 0 ? externalId.slice(0, idx) : null;
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
  if (input?.body && typeof input.body === 'object') {
    try {
      return JSON.stringify(input.body);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseWebhookPayload(body: unknown, rawBody: string): ClickUpWebhookPayload | null {
  if (body && typeof body === 'object') {
    return body as ClickUpWebhookPayload;
  }
  if (rawBody) {
    try {
      return JSON.parse(rawBody) as ClickUpWebhookPayload;
    } catch {
      return null;
    }
  }
  return null;
}

// Web Crypto is used so this plugin works in sandboxed runtimes (esbuild bundler
// without Node built-ins). Both Node 18+ and the plugin runtime expose
// `globalThis.crypto.subtle`.
async function verifyClickUpSignature(rawBody: string, signatureHeader: string, secret: string): Promise<boolean> {
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
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
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
