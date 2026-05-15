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
import { MondayClient } from './mondayClient';
import {
  MondayConfig,
  MondayItem,
  MondayWebhookPayload,
  SyncInput
} from './types';

const SYSTEM = 'monday';
const PROJECT_ENTITY = 'project';
const TASK_ENTITY = 'task';
const TODO_ENTITY = 'todo';
const USER_ENTITY = 'user';
const SYNC_STATE_KEY = 'monday:last-sync-time';
const STATUS_COLUMN_ID = 'status';

// monday.com identifies columns by id, which is configurable per board. We use
// the conventional default ids that monday.com auto-creates on most templates;
// when an item lacks them we fall back to the item.updated_at timestamp.
const DATE_START_COLUMN_ID = 'date';
const DATE_DUE_COLUMN_ID = 'date_1';
const TIMELINE_COLUMN_ID = 'timeline';
const PERSON_COLUMN_ID = 'person';

export interface MondaySyncResult {
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

let sharedClient: MondayClient | null = null;

export function resetSharedClient(): void {
  sharedClient = null;
}

export function createMondayClient(context: IntegrationContext<MondayConfig>): MondayClient {
  return new MondayClient({
    getAccessToken: () => context.credentials.getAccessToken(SYSTEM),
    refreshAccessToken: () => context.credentials.refreshToken(SYSTEM)
  });
}

function getOrCreateClient(context: IntegrationContext<MondayConfig>): MondayClient {
  if (!sharedClient) {
    sharedClient = createMondayClient(context);
  }
  return sharedClient;
}

export async function syncTaskToMonday(
  input: SyncInput,
  context: IntegrationContext<MondayConfig>,
  caches?: SyncBatchCaches
): Promise<MondaySyncResult> {
  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  if (syncDirection === 'monday-to-timesheet' || syncDirection === 'external-to-timesheet') {
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

  const projectBoardId = projectMapping.externalId;
  const client = getOrCreateClient(context);
  const taskMapping = await getMapping(context, caches?.taskMappingByLocalId, TASK_ENTITY, task.id);

  if (task.deleted) {
    if (taskMapping?.externalId) {
      await client.deleteItem(taskMapping.externalId);
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

  // Attribute the item to the mapped monday.com user when available. Without a
  // user mapping the item is created/updated under the OAuth owner.
  let externalUserId: string | undefined;
  const localUserId = task.user ?? task.member?.uid;
  if (localUserId) {
    const userMapping = await getMapping(context, caches?.userMappingByLocalId, USER_ENTITY, localUserId);
    if (userMapping?.externalId) {
      externalUserId = userMapping.externalId;
    }
  }

  // When the Timesheet task links to a synced ToDo, create the time entry as a
  // subitem of that ToDo's monday.com item. Otherwise it lands as a standalone
  // item on the project board (no parent).
  let parentItemId: string | undefined;
  const todoId = task.todo?.id;
  if (todoId) {
    const todoMapping = await getMapping(context, caches?.todoMappingByLocalId, TODO_ENTITY, todoId);
    if (todoMapping?.externalId) {
      parentItemId = todoMapping.externalId;
    }
  }

  let name: string;
  let columnValues: Record<string, unknown>;
  try {
    name = buildItemName(task);
    columnValues = buildMondayColumnValues(task, externalUserId);
  } catch (err) {
    context.logger.warn('Failed to build monday.com item payload', { taskId: task.id, error: String(err) });
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'invalid-task-data', taskId: task.id } };
  }

  let external: MondayItem;
  // The board id for updates is the subitems board when this is a subitem.
  // We persist it in the task mapping metadata so updates don't need an extra
  // lookup; on the first sync we read it back from the API response.
  const storedSubitemBoard = typeof taskMapping?.metadata?.boardId === 'string' ? taskMapping.metadata.boardId : undefined;

  if (taskMapping?.externalId) {
    const updateBoardId = storedSubitemBoard || projectBoardId;
    try {
      external = await client.updateItem(taskMapping.externalId, updateBoardId, name, columnValues);
    } catch (err) {
      if (String(err).toLowerCase().includes('not found')) {
        external = parentItemId
          ? await client.createSubitem(parentItemId, name, columnValues)
          : await client.createItem(projectBoardId, name, columnValues);
      } else {
        throw err;
      }
    }
  } else if (parentItemId) {
    external = await client.createSubitem(parentItemId, name, columnValues);
  } else {
    external = await client.createItem(projectBoardId, name, columnValues);
  }

  if (!external?.id) {
    return { system: SYSTEM, status: 'failed', syncedCount: 0, details: { reason: 'missing-external-id' } };
  }

  const upsertedMapping: MappingRecord = {
    localId: task.id,
    externalId: external.id,
    externalLabel: external.name ?? task.description ?? task.id,
    metadata: {
      // For subitems this is the subitems board id (returned by monday); for
      // standalone items it's the project board.
      boardId: external.board?.id ?? projectBoardId,
      projectBoardId,
      parentItemId: parentItemId ?? '',
      updatedAt: external.updated_at ?? ''
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
    details: { taskId: task.id, externalTaskId: external.id, asSubitem: !!parentItemId }
  };
}

export async function syncTodoToMonday(
  input: SyncInput,
  context: IntegrationContext<MondayConfig>,
  caches?: SyncBatchCaches
): Promise<MondaySyncResult> {
  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  if (syncDirection === 'monday-to-timesheet' || syncDirection === 'external-to-timesheet') {
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

  const boardId = projectMapping.externalId;
  const client = getOrCreateClient(context);
  const todoMapping = await getMapping(context, caches?.todoMappingByLocalId, TODO_ENTITY, todo.id);

  if (todo.deleted) {
    if (todoMapping?.externalId) {
      await client.deleteItem(todoMapping.externalId);
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

  const name = (todo.name?.trim() || `Timesheet todo ${todo.id}`).slice(0, 255);
  const columnValues = buildTodoColumnValues(todo);

  let external: MondayItem;
  if (todoMapping?.externalId) {
    try {
      external = await client.updateItem(todoMapping.externalId, boardId, name, columnValues);
    } catch (err) {
      if (String(err).toLowerCase().includes('not found')) {
        external = await client.createItem(boardId, name, columnValues);
      } else {
        throw err;
      }
    }
  } else {
    external = await client.createItem(boardId, name, columnValues);
  }

  if (!external?.id) {
    return { system: SYSTEM, status: 'failed', syncedCount: 0, details: { reason: 'missing-external-id' } };
  }

  const upsertedMapping: MappingRecord = {
    localId: todo.id,
    externalId: external.id,
    externalLabel: external.name ?? todo.name,
    metadata: {
      boardId,
      updatedAt: external.updated_at ?? ''
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
    details: { todoId: todo.id, externalItemId: external.id }
  };
}

export async function runMondayFullSync(
  context: IntegrationContext<MondayConfig>
): Promise<MondaySyncResult> {
  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  const allowInbound = syncDirection !== 'timesheet-to-monday' && syncDirection !== 'timesheet-to-external';

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
    const boardId = mapping.externalId;
    if (!boardId) {
      continue;
    }
    const items = await client.listItemsForBoard(boardId, { updatedSinceMs: sinceMs });
    for (const item of items) {
      const synced = await syncSingleExternalItem(context, mapping, item);
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
    details: { syncDirection, sinceMs: sinceMs ?? null, boardCount: projectMappings.length }
  };
}

export async function handleMondayWebhook(
  input: SyncInput,
  context: IntegrationContext<MondayConfig>
): Promise<MondaySyncResult> {
  const payload = parseWebhookPayload(input.body, input.rawBody);

  // monday.com performs a one-time `challenge` handshake when registering a
  // webhook. Echo it back so the subscription gets activated.
  if (payload?.challenge && typeof payload.challenge === 'string') {
    return {
      system: SYSTEM,
      status: 'challenge',
      syncedCount: 0,
      details: { challenge: payload.challenge }
    };
  }

  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  if (syncDirection === 'timesheet-to-monday' || syncDirection === 'timesheet-to-external') {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'sync-direction-mismatch' } };
  }

  const secret = context.config?.webhookSecret;
  if (!secret) {
    context.logger.warn('monday.com webhook rejected: webhookSecret not configured');
    return { system: SYSTEM, status: 'rejected', syncedCount: 0, details: { reason: 'secret-not-configured' } };
  }

  const authHeader = getHeader(input, 'authorization');
  if (!authHeader) {
    return { system: SYSTEM, status: 'rejected', syncedCount: 0, details: { reason: 'missing-signature' } };
  }

  if (!(await verifyMondaySignature(authHeader, secret))) {
    context.logger.warn('monday.com webhook rejected: signature mismatch');
    return { system: SYSTEM, status: 'rejected', syncedCount: 0, details: { reason: 'invalid-signature' } };
  }

  const event = payload?.event;
  const itemId = event ? String(event.pulseId ?? event.itemId ?? '') : '';
  const type = (event?.type ?? '').toLowerCase();

  if (!itemId) {
    return { system: SYSTEM, status: 'ignored', syncedCount: 0, details: { reason: 'no-item-id' } };
  }

  if (type === 'delete_pulse' || type === 'item_deleted') {
    const removed = await deleteLocalTaskByExternalId(context, itemId);
    return {
      system: SYSTEM,
      status: removed ? 'completed' : 'ignored',
      syncedCount: removed ? 1 : 0,
      details: { event: type, itemId }
    };
  }

  const client = getOrCreateClient(context);
  const externalItem = await client.getItem(itemId);
  if (!externalItem) {
    return { system: SYSTEM, status: 'ignored', syncedCount: 0, details: { reason: 'item-not-found', itemId } };
  }

  const projectMapping = await findProjectMappingForItem(context, externalItem, event?.boardId);
  if (!projectMapping) {
    return { system: SYSTEM, status: 'ignored', syncedCount: 0, details: { reason: 'no-matching-project-mapping', itemId } };
  }

  const synced = await syncSingleExternalItem(context, projectMapping, externalItem);
  return {
    system: SYSTEM,
    status: 'completed',
    syncedCount: synced ? 1 : 0,
    details: { event: type, itemId }
  };
}

export async function syncTaskFromMonday(
  input: SyncInput,
  context: IntegrationContext<MondayConfig>
): Promise<MondaySyncResult> {
  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  if (syncDirection === 'timesheet-to-monday' || syncDirection === 'timesheet-to-external') {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'sync-direction-mismatch' } };
  }

  const externalTaskId = input?.externalTaskId;
  if (!externalTaskId) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'missing-external-task-id' } };
  }

  const client = getOrCreateClient(context);
  const externalItem = await client.getItem(externalTaskId);
  if (!externalItem) {
    return { system: SYSTEM, status: 'ignored', syncedCount: 0, details: { reason: 'item-not-found', externalTaskId } };
  }

  const projectMapping = await findProjectMappingForItem(context, externalItem);
  if (!projectMapping) {
    return { system: SYSTEM, status: 'ignored', syncedCount: 0, details: { reason: 'no-matching-project-mapping' } };
  }

  const synced = await syncSingleExternalItem(context, projectMapping, externalItem);
  return {
    system: SYSTEM,
    status: 'completed',
    syncedCount: synced ? 1 : 0,
    details: { externalTaskId }
  };
}

async function syncSingleExternalItem(
  context: IntegrationContext<MondayConfig>,
  projectMapping: MappingRecord,
  external: MondayItem
): Promise<boolean> {
  if (!external?.id) {
    return false;
  }

  // Subitems represent Timesheet tasks (time entries) under their parent ToDo.
  // Parent items represent Timesheet ToDos. Route inbound by parent_item.
  if (external.parent_item?.id) {
    return syncInboundTaskFromSubitem(context, projectMapping, external);
  }
  return syncInboundTodoFromItem(context, projectMapping, external);
}

async function syncInboundTaskFromSubitem(
  context: IntegrationContext<MondayConfig>,
  projectMapping: MappingRecord,
  external: MondayItem
): Promise<boolean> {
  const dateRange = toTaskDateRange(external);
  if (!dateRange) {
    return false;
  }

  const taskMapping = await context.mappings.findByExternal({
    system: SYSTEM,
    entity: TASK_ENTITY,
    externalId: external.id
  });

  const description = external.name ?? '';

  if (!taskMapping?.localId) {
    const created = await context.data.createTask({
      projectId: projectMapping.localId,
      startDateTime: dateRange.startDateTime,
      endDateTime: dateRange.endDateTime,
      description
    } as TaskCreateInput);

    await context.mappings.upsert({
      system: SYSTEM,
      entity: TASK_ENTITY,
      localId: created.id,
      externalId: external.id,
      externalLabel: external.name ?? external.id,
      metadata: {
        boardId: external.board?.id ?? '',
        projectBoardId: projectMapping.externalId ?? '',
        parentItemId: external.parent_item?.id ?? '',
        updatedAt: external.updated_at ?? ''
      },
      syncStatus: 'SYNCED'
    });

    return true;
  }

  const existing = await context.data.getTask(taskMapping.localId);
  const externalUpdatedAt = parseMondayDateMs(external.updated_at);
  if (existing?.lastUpdate && externalUpdatedAt && externalUpdatedAt <= existing.lastUpdate) {
    return false;
  }

  await context.data.updateTask(taskMapping.localId, {
    projectId: projectMapping.localId,
    startDateTime: dateRange.startDateTime,
    endDateTime: dateRange.endDateTime,
    description
  } as TaskUpdateInput);

  await context.mappings.upsert({
    system: SYSTEM,
    entity: TASK_ENTITY,
    localId: taskMapping.localId,
    externalId: external.id,
    externalLabel: external.name ?? external.id,
    metadata: {
      boardId: external.board?.id ?? '',
      projectBoardId: projectMapping.externalId ?? '',
      parentItemId: external.parent_item?.id ?? '',
      updatedAt: external.updated_at ?? ''
    },
    syncStatus: 'SYNCED'
  });

  return true;
}

async function syncInboundTodoFromItem(
  context: IntegrationContext<MondayConfig>,
  projectMapping: MappingRecord,
  external: MondayItem
): Promise<boolean> {
  const todoMapping = await context.mappings.findByExternal({
    system: SYSTEM,
    entity: TODO_ENTITY,
    externalId: external.id
  });

  const name = external.name?.trim() || external.id;
  const dueDate = extractDueDate(external);
  const status = mapMondayStatusToLocal(external.column_values);

  if (!todoMapping?.localId) {
    const created = await context.data.createTodo({
      projectId: projectMapping.localId,
      name,
      description: '',
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
        boardId: projectMapping.externalId ?? '',
        updatedAt: external.updated_at ?? ''
      },
      syncStatus: 'SYNCED'
    });
    return true;
  }

  const existing = await context.data.getTodo(todoMapping.localId);
  const externalUpdatedAt = parseMondayDateMs(external.updated_at);
  if (existing?.lastUpdate && externalUpdatedAt && externalUpdatedAt <= existing.lastUpdate) {
    return false;
  }

  await context.data.updateTodo(todoMapping.localId, {
    name,
    description: existing?.description ?? '',
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
      boardId: projectMapping.externalId ?? '',
      updatedAt: external.updated_at ?? ''
    },
    syncStatus: 'SYNCED'
  });
  return true;
}

async function deleteLocalTaskByExternalId(
  context: IntegrationContext<MondayConfig>,
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
    context.logger.warn('Failed to delete local task for monday.com delete event', {
      localId: mapping.localId,
      externalId,
      error: String(err)
    });
  }
  await context.mappings.delete({
    system: SYSTEM,
    entity: TASK_ENTITY,
    localId: mapping.localId
  });
  return true;
}

async function findProjectMappingForItem(
  context: IntegrationContext<MondayConfig>,
  external: MondayItem,
  hintedBoardId?: number | string
): Promise<MappingRecord | null> {
  // Subitems live on a sibling "subitems board" — we want the parent item's
  // board for matching project mappings. Fall back to the item's own board
  // for parent items, and finally the webhook hint.
  const subitemParentBoard = external.parent_item?.board?.id;
  const boardId = String(subitemParentBoard ?? external.board?.id ?? hintedBoardId ?? '');
  if (!boardId) {
    return null;
  }
  const projectMappings = await context.mappings.list({ system: SYSTEM, entity: PROJECT_ENTITY });
  return projectMappings.find((mapping) => mapping.externalId === boardId) ?? null;
}

async function getMapping(
  context: IntegrationContext<MondayConfig>,
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
  context: IntegrationContext<MondayConfig>
): Promise<TaskDto | null> {
  // Sync changes ship a flat payload (projectId, taskId) — normalize to the
  // nested API shape (project: { id }) the rest of the pipeline expects.
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
  context: IntegrationContext<MondayConfig>
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

function buildItemName(task: TaskDto): string {
  const description = task.description?.trim();
  if (description) {
    return description.length > 255 ? `${description.slice(0, 252)}...` : description;
  }
  if (task.project?.title) {
    return `Timesheet entry — ${task.project.title}`;
  }
  return `Timesheet entry ${task.id}`;
}

function buildMondayColumnValues(task: TaskDto, externalUserId?: string): Record<string, unknown> {
  const start = parseDate(task.startDateTime);
  const end = parseDate(task.endDateTime);

  if (!start || !end) {
    throw new Error(`Task ${task.id} is missing start or end datetime.`);
  }

  const values: Record<string, unknown> = {
    [DATE_START_COLUMN_ID]: formatMondayDate(start),
    [DATE_DUE_COLUMN_ID]: formatMondayDate(end),
    [TIMELINE_COLUMN_ID]: {
      from: toIsoDate(start),
      to: toIsoDate(end)
    }
  };

  if (externalUserId) {
    // Person column accepts a list of `{ id, kind }` entries. Numeric ids are
    // expected, but stringified ids are tolerated by the API.
    const numericId = Number(externalUserId);
    values[PERSON_COLUMN_ID] = {
      personsAndTeams: [
        {
          id: Number.isFinite(numericId) ? numericId : externalUserId,
          kind: 'person'
        }
      ]
    };
  }

  return values;
}

function buildTodoColumnValues(todo: ToDoDto): Record<string, unknown> {
  const values: Record<string, unknown> = {};

  if (todo.dueDate) {
    const due = parseDate(todo.dueDate);
    if (due) {
      values[DATE_DUE_COLUMN_ID] = formatMondayDate(due);
    }
  }

  // monday.com status columns are workspace-defined. We only mark "closed"
  // ToDos by sending the canonical "Done" label; "open" is left untouched so
  // the workspace's default status is preserved.
  if (typeof todo.status === 'number' && todo.status === 1) {
    values[STATUS_COLUMN_ID] = { label: 'Done' };
  }

  return values;
}

function extractDueDate(external: MondayItem): string | undefined {
  const due = pickDateColumn(external.column_values, DATE_DUE_COLUMN_ID);
  return due ? new Date(due).toISOString() : undefined;
}

function mapMondayStatusToLocal(columns: MondayItem['column_values']): number | undefined {
  const status = columns?.find((column) => column.id === STATUS_COLUMN_ID);
  const label = (status?.text ?? '').trim().toLowerCase();
  if (!label) {
    return undefined;
  }
  // Mirror the outbound rule: only "Done" (and obvious synonyms) flip the ToDo
  // to closed. Anything else leaves it open.
  return label === 'done' || label === 'closed' || label === 'complete' || label === 'completed' ? 1 : 0;
}

function formatMondayDate(date: Date): { date: string; time: string } {
  return {
    date: toIsoDate(date),
    time: toIsoTime(date)
  };
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toIsoTime(date: Date): string {
  return date.toISOString().slice(11, 19);
}

function toTaskDateRange(external: MondayItem): { startDateTime: string; endDateTime: string } | null {
  const range = extractDateRange(external);
  if (!range) {
    return null;
  }
  return {
    startDateTime: new Date(range.startMs).toISOString(),
    endDateTime: new Date(range.endMs).toISOString()
  };
}

function extractDateRange(external: MondayItem): { startMs: number; endMs: number } | null {
  const columns = external.column_values ?? [];
  const start = pickDateColumn(columns, DATE_START_COLUMN_ID);
  const end = pickDateColumn(columns, DATE_DUE_COLUMN_ID);
  if (start && end && end > start) {
    return { startMs: start, endMs: end };
  }
  const timeline = pickTimelineColumn(columns, TIMELINE_COLUMN_ID);
  if (timeline && timeline.endMs > timeline.startMs) {
    return timeline;
  }
  return null;
}

interface RawColumnValue {
  date?: string;
  time?: string | null;
  from?: string;
  to?: string;
}

function pickDateColumn(columns: MondayItem['column_values'], id: string): number | null {
  const column = columns?.find((c) => c.id === id);
  if (!column?.value) {
    return null;
  }
  let parsed: RawColumnValue;
  try {
    parsed = JSON.parse(column.value) as RawColumnValue;
  } catch {
    return null;
  }
  if (!parsed?.date) {
    return null;
  }
  const iso = parsed.time ? `${parsed.date}T${parsed.time}Z` : `${parsed.date}T00:00:00Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function pickTimelineColumn(columns: MondayItem['column_values'], id: string): { startMs: number; endMs: number } | null {
  const column = columns?.find((c) => c.id === id);
  if (!column?.value) {
    return null;
  }
  let parsed: RawColumnValue;
  try {
    parsed = JSON.parse(column.value) as RawColumnValue;
  } catch {
    return null;
  }
  if (!parsed?.from || !parsed?.to) {
    return null;
  }
  const startMs = Date.parse(`${parsed.from}T00:00:00Z`);
  const endMs = Date.parse(`${parsed.to}T23:59:59Z`);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return null;
  }
  return { startMs, endMs };
}

function parseDate(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseMondayDateMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
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

function parseWebhookPayload(body: unknown, rawBody: string | undefined): MondayWebhookPayload | null {
  if (body && typeof body === 'object') {
    return body as MondayWebhookPayload;
  }
  if (rawBody) {
    try {
      return JSON.parse(rawBody) as MondayWebhookPayload;
    } catch {
      return null;
    }
  }
  return null;
}

// Web Crypto is used so this plugin works in sandboxed runtimes (esbuild bundler
// without Node built-ins). Both Node 18+ and the plugin runtime expose
// `globalThis.crypto.subtle`.
async function verifyMondaySignature(authHeader: string, secret: string): Promise<boolean> {
  // monday.com signs webhook deliveries with a JWT (HS256) in the Authorization
  // header. Anything else is treated as invalid.
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const parts = token.split('.');
  if (parts.length !== 3) {
    return false;
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await globalThis.crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${headerB64}.${payloadB64}`)
  );
  const expected = bufferToBase64Url(signatureBuffer);
  return constantTimeEquals(expected, signatureB64);
}

function bufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = typeof btoa === 'function'
    ? btoa(binary)
    // Fallback for environments where btoa isn't a global (older Node test runs).
    : Buffer.from(binary, 'binary').toString('base64');
  return base64.replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
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
