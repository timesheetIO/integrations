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
import { MondayClient } from './mondayClient';
import {
  MondayBoardColumns,
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
// Import locks close the webhook-vs-full-sync race on first import; held for
// the TTL (not released on success) so duplicate webhook deliveries stay
// suppressed until the new mapping is visible everywhere.
const IMPORT_LOCK_TTL_SECONDS = 60 * 60;
const STATUS_COLUMN_ID = 'status';

// Titles used when the plugin has to create its own date columns. monday.com
// generates random ids for new columns, but the title is what users see.
const TIMESHEET_START_COLUMN_TITLE = 'Timesheet Start';
const TIMESHEET_END_COLUMN_TITLE = 'Timesheet End';

const DEFAULT_ITEM_NAME_TEMPLATE = 'Timesheet entry {startDate} {startTime}–{endTime}';

function boardColumnsCacheKey(boardId: string): string {
  return `monday:columns:${boardId}`;
}

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

/**
 * The Timesheet user ↔ monday.com user mapping, keyed both ways. `configured`
 * is false on installations that never mapped anyone, which is the normal
 * single-user case and keeps the previous behavior.
 */
export interface UserMappingIndex {
  localToExternal: Map<string, string>;
  externalToLocal: Map<string, string>;
  configured: boolean;
}

/**
 * Reads the user mapping once per invocation. Organization installs run their
 * inbound work as the installing admin, so without this every member's
 * monday.com time would be booked on that admin.
 */
export async function loadUserMappingIndex(
  context: IntegrationContext<MondayConfig>
): Promise<UserMappingIndex> {
  let records: MappingRecord[] = [];
  try {
    records = await context.mappings.list({ system: SYSTEM, entity: USER_ENTITY });
  } catch (err) {
    context.logger.warn('Failed to load monday.com user mappings', { error: String(err) });
  }

  const localToExternal = new Map<string, string>();
  const externalToLocal = new Map<string, string>();
  for (const record of records) {
    if (!record.localId || !record.externalId) continue;
    localToExternal.set(record.localId, record.externalId);
    // Two Timesheet users may point at one monday.com user; the first wins
    // inbound so imports stay deterministic.
    if (!externalToLocal.has(record.externalId)) {
      externalToLocal.set(record.externalId, record.localId);
    }
  }

  return { localToExternal, externalToLocal, configured: localToExternal.size > 0 };
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

  // Echo guard: a change not newer than our own last write for this task is
  // the event fired by that write — syncing it back would ping-pong forever.
  if (taskMapping?.externalId && isAlreadySyncedLocalChange(taskMapping.metadata, getLastUpdateMillis(task))) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'already-synced-task-change', taskId: task.id } };
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
  try {
    name = buildItemName(task, context.config?.itemNameTemplate);
  } catch (err) {
    context.logger.warn('Failed to build monday.com item name', { taskId: task.id, error: String(err) });
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'invalid-task-data', taskId: task.id } };
  }

  let external: MondayItem;
  // The board id for updates is the subitems board when this is a subitem.
  // We persist it in the task mapping metadata so updates don't need an extra
  // lookup; on the first sync we read it back from the API response.
  const storedSubitemBoard = typeof taskMapping?.metadata?.boardId === 'string' ? taskMapping.metadata.boardId : undefined;

  if (taskMapping?.externalId) {
    const updateBoardId = storedSubitemBoard || projectBoardId;
    const cols = await ensureBoardColumns(context, client, updateBoardId);
    const columnValues = buildColumnValuesOrSkip(task, externalUserId, cols, context);
    if (!columnValues) {
      return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'invalid-task-data', taskId: task.id } };
    }
    try {
      external = await client.updateItem(taskMapping.externalId, updateBoardId, name, columnValues);
    } catch (err) {
      if (String(err).toLowerCase().includes('not found')) {
        external = parentItemId
          ? await createSubitemWithColumns(client, context, parentItemId, name, task, externalUserId)
          : await createItemWithColumns(client, context, projectBoardId, name, task, externalUserId);
      } else {
        throw err;
      }
    }
  } else if (parentItemId) {
    external = await createSubitemWithColumns(client, context, parentItemId, name, task, externalUserId);
  } else {
    external = await createItemWithColumns(client, context, projectBoardId, name, task, externalUserId);
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
      ...syncMetadataStamp({
        localLastUpdateMillis: getLastUpdateMillis(task),
        externalUpdatedAt: external.updated_at,
        externalUpdatedKey: 'updatedAt'
      })
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

  // Echo guard: skip the event fired by our own inbound todo import/update.
  if (todoMapping?.externalId && isAlreadySyncedLocalChange(todoMapping.metadata, getLastUpdateMillis(todo))) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'already-synced-todo-change', todoId: todo.id } };
  }

  const name = (todo.name?.trim() || `Timesheet todo ${todo.id}`).slice(0, 255);
  const cols = await ensureBoardColumns(context, client, boardId);
  const columnValues = buildTodoColumnValues(todo, cols);

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
      ...syncMetadataStamp({
        localLastUpdateMillis: getLastUpdateMillis(todo),
        externalUpdatedAt: external.updated_at,
        externalUpdatedKey: 'updatedAt'
      })
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
  const allowOutbound = syncDirection !== 'monday-to-timesheet' && syncDirection !== 'external-to-timesheet';
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

  const [taskMappings, todoMappings, userMappings] = await Promise.all([
    context.mappings.list({ system: SYSTEM, entity: TASK_ENTITY }),
    context.mappings.list({ system: SYSTEM, entity: TODO_ENTITY }),
    context.mappings.list({ system: SYSTEM, entity: USER_ENTITY })
  ]);

  const projectMappingByLocalId = new Map<string, MappingRecord>();
  for (const m of projectMappings) projectMappingByLocalId.set(m.localId, m);
  const taskMappingByLocalId = new Map<string, MappingRecord>();
  for (const m of taskMappings) taskMappingByLocalId.set(m.localId, m);
  const todoMappingByLocalId = new Map<string, MappingRecord>();
  for (const m of todoMappings) todoMappingByLocalId.set(m.localId, m);
  const userMappingByLocalId = new Map<string, MappingRecord>();
  for (const m of userMappings) userMappingByLocalId.set(m.localId, m);

  const caches: SyncBatchCaches = {
    projectMappingByLocalId,
    taskMappingByLocalId,
    todoMappingByLocalId,
    userMappingByLocalId
  };

  // Coerce defensively — the runtime has occasionally been observed handing
  // back wrapper objects instead of the raw number we stored. Anything that
  // isn't a finite positive epoch-ms value falls through to a full resync.
  const rawSince = await context.state.get<unknown>(SYNC_STATE_KEY);
  const sinceMs = typeof rawSince === 'number' && Number.isFinite(rawSince) && rawSince > 0
    ? rawSince
    : undefined;
  const startedAt = Date.now();

  let outboundCount = 0;
  let inboundCount = 0;
  const errors: Array<{ direction: 'outbound' | 'inbound'; entityType: string; entityId: string; error: string }> = [];

  if (allowOutbound) {
    // ToDos first across all projects so subitem parents exist when their
    // time entries push as subitems.
    for (const projectMapping of projectMappings) {
      if (!projectMapping.externalId) continue;
      try {
        for await (const todo of iterateLocalTodos(context, projectMapping.localId)) {
          if (todo.deleted) continue;
          if (sinceMs && typeof todo.lastUpdate === 'number' && todo.lastUpdate <= sinceMs) continue;
          try {
            const result = await syncTodoToMonday(
              { event: 'todo.update', todoId: todo.id, item: todo as unknown as SyncInput['item'] },
              context,
              caches
            );
            if (result.status === 'synced' || result.status === 'deleted') outboundCount += 1;
          } catch (err) {
            errors.push({ direction: 'outbound', entityType: TODO_ENTITY, entityId: todo.id, error: String(err) });
            context.logger.warn('Outbound todo backfill failed', { todoId: todo.id, error: String(err) });
          }
        }
      } catch (err) {
        errors.push({ direction: 'outbound', entityType: 'project-todos', entityId: projectMapping.localId, error: String(err) });
        context.logger.error('Failed to list todos for outbound backfill', { projectId: projectMapping.localId, error: String(err) });
      }
    }

    for (const projectMapping of projectMappings) {
      if (!projectMapping.externalId) continue;
      try {
        for await (const task of iterateLocalTasks(context, projectMapping.localId)) {
          if (task.deleted || task.running) continue;
          if (sinceMs && typeof task.lastUpdate === 'number' && task.lastUpdate <= sinceMs) continue;
          try {
            const result = await syncTaskToMonday(
              { event: 'task.update', taskId: task.id, item: task as unknown as SyncInput['item'] },
              context,
              caches
            );
            if (result.status === 'synced' || result.status === 'deleted') outboundCount += 1;
          } catch (err) {
            errors.push({ direction: 'outbound', entityType: TASK_ENTITY, entityId: task.id, error: String(err) });
            context.logger.warn('Outbound task backfill failed', { taskId: task.id, error: String(err) });
          }
        }
      } catch (err) {
        errors.push({ direction: 'outbound', entityType: 'project-tasks', entityId: projectMapping.localId, error: String(err) });
        context.logger.error('Failed to list tasks for outbound backfill', { projectId: projectMapping.localId, error: String(err) });
      }
    }
  }

  if (allowInbound) {
    const client = getOrCreateClient(context);
    const inboundUsers = await loadUserMappingIndex(context);
    for (const mapping of projectMappings) {
      const boardId = mapping.externalId;
      if (!boardId) continue;
      try {
        const items = await client.listItemsForBoard(boardId, { updatedSinceMs: sinceMs });
        for (const item of items) {
          try {
            const synced = await syncSingleExternalItem(context, mapping, item, inboundUsers);
            if (synced) inboundCount += 1;
          } catch (err) {
            errors.push({ direction: 'inbound', entityType: 'item', entityId: item.id, error: String(err) });
            context.logger.warn('Inbound item sync failed', { itemId: item.id, boardId, error: String(err) });
          }
        }
      } catch (err) {
        errors.push({ direction: 'inbound', entityType: 'board', entityId: boardId, error: String(err) });
        context.logger.error('Failed to list board items for inbound sync', { boardId, error: String(err) });
      }
    }
  }

  await context.state.set(SYNC_STATE_KEY, startedAt);

  return {
    system: SYSTEM,
    status: errors.length > 0 ? 'partial' : 'completed',
    syncedCount: outboundCount + inboundCount,
    details: {
      syncDirection,
      sinceMs: sinceMs ?? null,
      boardCount: projectMappings.length,
      outboundCount,
      inboundCount,
      errors: errors.length > 0 ? errors : undefined
    }
  };
}

async function* iterateLocalTodos(
  context: IntegrationContext<MondayConfig>,
  projectId: string
): AsyncGenerator<ToDoDto> {
  const pageSize = 100;
  let page = 1;
  while (true) {
    const result = await context.data.listTodos({ projectId, page, count: pageSize });
    const items = result?.items ?? [];
    for (const todo of items) yield todo;
    if (items.length < pageSize) break;
    page += 1;
  }
}

async function* iterateLocalTasks(
  context: IntegrationContext<MondayConfig>,
  projectId: string
): AsyncGenerator<TaskDto> {
  const pageSize = 100;
  let page = 1;
  while (true) {
    const result = await context.data.listTasks({
      projectId,
      page,
      count: pageSize,
      populatePauses: false,
      populateExpenses: false,
      populateNotes: false,
      populateTags: false
    });
    const items = result?.items ?? [];
    for (const task of items) yield task;
    if (items.length < pageSize) break;
    page += 1;
  }
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

  const synced = await syncSingleExternalItem(
    context, projectMapping, externalItem, await loadUserMappingIndex(context));
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

  const synced = await syncSingleExternalItem(
    context, projectMapping, externalItem, await loadUserMappingIndex(context));
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
  external: MondayItem,
  users: UserMappingIndex
): Promise<boolean> {
  if (!external?.id) {
    return false;
  }

  // Subitems represent Timesheet tasks (time entries) under their parent ToDo.
  // Parent items represent Timesheet ToDos. Route inbound by parent_item.
  if (external.parent_item?.id) {
    return syncInboundTaskFromSubitem(context, projectMapping, external, users);
  }
  return syncInboundTodoFromItem(context, projectMapping, external);
}

async function syncInboundTaskFromSubitem(
  context: IntegrationContext<MondayConfig>,
  projectMapping: MappingRecord,
  external: MondayItem,
  users: UserMappingIndex
): Promise<boolean> {
  const subitemBoardId = external.board?.id;
  const cols = subitemBoardId
    ? await ensureBoardColumns(context, getOrCreateClient(context), subitemBoardId)
    : {};
  const dateRange = toTaskDateRange(external, cols);
  if (!dateRange) {
    return false;
  }

  const taskMapping = await context.mappings.findByExternal({
    system: SYSTEM,
    entity: TASK_ENTITY,
    externalId: external.id
  });

  const description = external.name ?? '';

  const externalUserId = external.creator_id != null ? String(external.creator_id) : undefined;
  const localUserId = externalUserId ? users.externalToLocal.get(externalUserId) : undefined;
  if (users.configured && !localUserId) {
    // An installation that maps users expects per-member attribution. Importing
    // an unmapped person's time would book it on whoever the inbound sync runs
    // as, which on an organization install is the installing admin.
    context.logger.info('Skipping monday.com subitem for an unmapped user', {
      externalId: external.id,
      mondayUserId: externalUserId
    });
    return false;
  }

  if (!taskMapping?.localId) {
    // Import lock: a webhook delivery racing a full sync must not create the
    // same task twice. Held for the TTL; released only when the create fails.
    const lockKey = `import:task:${external.id}`;
    if (!(await tryAcquireStateLock(context.state, lockKey, IMPORT_LOCK_TTL_SECONDS))) {
      context.logger.info('monday.com subitem import already in progress, skipping duplicate create', {
        externalId: external.id
      });
      return false;
    }

    let created: TaskDto;
    try {
      // Attribution is create-only: TaskUpdateInput carries no userId, so a task
      // imported for the wrong member cannot be moved later.
      created = await context.data.createTask({
        projectId: projectMapping.localId,
        startDateTime: dateRange.startDateTime,
        endDateTime: dateRange.endDateTime,
        description,
        ...(localUserId ? { userId: localUserId } : {})
      } as TaskCreateInput);
      if (localUserId && created?.user && created.user !== localUserId) {
        // The backend drops userId when the acting profile has no team features
        // and books the task on itself instead.
        context.logger.error('monday.com subitem was booked on the wrong member', {
          externalId: external.id,
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
      externalId: external.id,
      externalLabel: external.name ?? external.id,
      metadata: {
        boardId: external.board?.id ?? '',
        projectBoardId: projectMapping.externalId ?? '',
        parentItemId: external.parent_item?.id ?? '',
        ...syncMetadataStamp({
          localLastUpdateMillis: getLastUpdateMillis(created),
          externalUpdatedAt: external.updated_at,
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
    metadata: taskMapping.metadata,
    metadataKey: 'updatedAt',
    externalUpdatedAt: external.updated_at
  })) {
    return false;
  }

  const existing = await context.data.getTask(taskMapping.localId);
  if (isStaleExternalChange({
    externalUpdatedAt: external.updated_at,
    localLastUpdateMillis: getLastUpdateMillis(existing)
  })) {
    return false;
  }

  const updated = await context.data.updateTask(taskMapping.localId, {
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
      ...syncMetadataStamp({
        localLastUpdateMillis: getLastUpdateMillis(updated),
        externalUpdatedAt: external.updated_at,
        externalUpdatedKey: 'updatedAt'
      })
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
  const itemBoardId = external.board?.id;
  const cols = itemBoardId
    ? await ensureBoardColumns(context, getOrCreateClient(context), itemBoardId)
    : {};
  const dueDate = extractDueDate(external, cols);
  const status = mapMondayStatusToLocal(external.column_values);

  if (!todoMapping?.localId) {
    // Import lock: a webhook delivery racing a full sync must not create the
    // same todo twice. Held for the TTL; released only when the create fails.
    const lockKey = `import:todo:${external.id}`;
    if (!(await tryAcquireStateLock(context.state, lockKey, IMPORT_LOCK_TTL_SECONDS))) {
      context.logger.info('monday.com item import already in progress, skipping duplicate create', {
        externalId: external.id
      });
      return false;
    }

    let created: ToDoDto;
    try {
      created = await context.data.createTodo({
        projectId: projectMapping.localId,
        name,
        description: '',
        dueDate,
        status
      } as ToDoCreateInput);
    } catch (err) {
      await releaseStateLock(context.state, lockKey);
      throw err;
    }

    await context.mappings.upsert({
      system: SYSTEM,
      entity: TODO_ENTITY,
      localId: created.id,
      externalId: external.id,
      externalLabel: external.name ?? external.id,
      metadata: {
        boardId: projectMapping.externalId ?? '',
        ...syncMetadataStamp({
          localLastUpdateMillis: getLastUpdateMillis(created),
          externalUpdatedAt: external.updated_at,
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
    externalUpdatedAt: external.updated_at
  })) {
    return false;
  }

  const existing = await context.data.getTodo(todoMapping.localId);
  if (isStaleExternalChange({
    externalUpdatedAt: external.updated_at,
    localLastUpdateMillis: getLastUpdateMillis(existing)
  })) {
    return false;
  }

  const updated = await context.data.updateTodo(todoMapping.localId, {
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
      ...syncMetadataStamp({
        localLastUpdateMillis: getLastUpdateMillis(updated),
        externalUpdatedAt: external.updated_at,
        externalUpdatedKey: 'updatedAt'
      })
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

function buildItemName(task: TaskDto, template?: string): string {
  const description = task.description?.trim();
  if (description) {
    return description.length > 255 ? `${description.slice(0, 252)}...` : description;
  }
  const rendered = renderNameTemplate(template || DEFAULT_ITEM_NAME_TEMPLATE, task).trim();
  const final = rendered || `Timesheet entry ${task.id}`;
  return final.length > 255 ? `${final.slice(0, 252)}...` : final;
}

function renderNameTemplate(template: string, task: TaskDto): string {
  const start = parseDate(task.startDateTime);
  const end = parseDate(task.endDateTime);
  const replacements: Record<string, string> = {
    description: task.description?.trim() ?? '',
    projectTitle: task.project?.title ?? '',
    taskId: task.id ?? '',
    startDate: start ? toIsoDate(start) : '',
    startTime: start ? toIsoTime(start).slice(0, 5) : '',
    endDate: end ? toIsoDate(end) : '',
    endTime: end ? toIsoTime(end).slice(0, 5) : '',
    startDateTime: start ? `${toIsoDate(start)} ${toIsoTime(start).slice(0, 5)}` : '',
    endDateTime: end ? `${toIsoDate(end)} ${toIsoTime(end).slice(0, 5)}` : ''
  };
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    return key in replacements ? replacements[key] : match;
  });
}

function buildMondayColumnValues(
  task: TaskDto,
  externalUserId: string | undefined,
  cols: MondayBoardColumns
): Record<string, unknown> {
  const start = parseDate(task.startDateTime);
  const end = parseDate(task.endDateTime);

  if (!start || !end) {
    throw new Error(`Task ${task.id} is missing start or end datetime.`);
  }

  const values: Record<string, unknown> = {};
  if (cols.dateStartId) {
    values[cols.dateStartId] = formatMondayDate(start);
  }
  if (cols.dateEndId) {
    values[cols.dateEndId] = formatMondayDate(end);
  }

  if (externalUserId && cols.personId) {
    // Person column accepts a list of `{ id, kind }` entries. Numeric ids are
    // expected, but stringified ids are tolerated by the API.
    const numericId = Number(externalUserId);
    values[cols.personId] = {
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

function buildColumnValuesOrSkip(
  task: TaskDto,
  externalUserId: string | undefined,
  cols: MondayBoardColumns,
  context: IntegrationContext<MondayConfig>
): Record<string, unknown> | null {
  try {
    return buildMondayColumnValues(task, externalUserId, cols);
  } catch (err) {
    context.logger.warn('Failed to build monday.com item payload', { taskId: task.id, error: String(err) });
    return null;
  }
}

// New subitems land on monday's sibling "subitems board", whose id is only
// known after creation. Create the subitem first with just a name, then
// discover the subitems board's columns and update the date/person values.
async function createSubitemWithColumns(
  client: MondayClient,
  context: IntegrationContext<MondayConfig>,
  parentItemId: string,
  name: string,
  task: TaskDto,
  externalUserId: string | undefined
): Promise<MondayItem> {
  const created = await client.createSubitem(parentItemId, name, {});
  const subitemBoardId = created.board?.id;
  if (!subitemBoardId) {
    return created;
  }
  const cols = await ensureBoardColumns(context, client, subitemBoardId);
  const columnValues = buildColumnValuesOrSkip(task, externalUserId, cols, context);
  if (!columnValues || Object.keys(columnValues).length === 0) {
    return created;
  }
  try {
    return await client.updateItem(created.id, subitemBoardId, name, columnValues);
  } catch (err) {
    context.logger.warn('Failed to set subitem column values after create', { itemId: created.id, error: String(err) });
    return created;
  }
}

async function createItemWithColumns(
  client: MondayClient,
  context: IntegrationContext<MondayConfig>,
  boardId: string,
  name: string,
  task: TaskDto,
  externalUserId: string | undefined
): Promise<MondayItem> {
  const cols = await ensureBoardColumns(context, client, boardId);
  const columnValues = buildColumnValuesOrSkip(task, externalUserId, cols, context);
  return client.createItem(boardId, name, columnValues ?? {});
}

function buildTodoColumnValues(todo: ToDoDto, cols: MondayBoardColumns): Record<string, unknown> {
  const values: Record<string, unknown> = {};

  if (todo.dueDate && cols.dateEndId) {
    const due = parseDate(todo.dueDate);
    if (due) {
      values[cols.dateEndId] = formatMondayDate(due);
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

function extractDueDate(external: MondayItem, cols: MondayBoardColumns): string | undefined {
  if (!cols.dateEndId) {
    return undefined;
  }
  const due = pickDateColumn(external.column_values, cols.dateEndId);
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

function toTaskDateRange(external: MondayItem, cols: MondayBoardColumns): { startDateTime: string; endDateTime: string } | null {
  const range = extractDateRange(external, cols);
  if (!range) {
    return null;
  }
  return {
    startDateTime: new Date(range.startMs).toISOString(),
    endDateTime: new Date(range.endMs).toISOString()
  };
}

function extractDateRange(external: MondayItem, cols: MondayBoardColumns): { startMs: number; endMs: number } | null {
  const columns = external.column_values ?? [];
  if (!cols.dateStartId || !cols.dateEndId) {
    return null;
  }
  const start = pickDateColumn(columns, cols.dateStartId);
  const end = pickDateColumn(columns, cols.dateEndId);
  if (start && end && end > start) {
    return { startMs: start, endMs: end };
  }
  return null;
}

async function ensureBoardColumns(
  context: IntegrationContext<MondayConfig>,
  client: MondayClient,
  boardId: string
): Promise<MondayBoardColumns> {
  const cacheKey = boardColumnsCacheKey(boardId);
  const cached = await context.state.get<MondayBoardColumns>(cacheKey);
  if (cached && cached.dateStartId && cached.dateEndId) {
    return cached;
  }

  let columns;
  try {
    columns = await client.listBoardColumns(boardId);
  } catch (err) {
    context.logger.warn('Failed to list board columns', { boardId, error: String(err) });
    return cached ?? {};
  }

  const dateColumns = columns.filter((c) => c.type === 'date');
  const peopleColumns = columns.filter((c) => c.type === 'people' || c.type === 'multiple-person');

  const byTitle = (title: string) => dateColumns.find((c) => (c.title ?? '').trim().toLowerCase() === title.toLowerCase());

  let startCol = byTitle(TIMESHEET_START_COLUMN_TITLE);
  let endCol = byTitle(TIMESHEET_END_COLUMN_TITLE);

  if (!startCol) {
    try {
      startCol = await client.createColumn(boardId, TIMESHEET_START_COLUMN_TITLE, 'date');
    } catch (err) {
      context.logger.warn('Failed to create Timesheet Start column', { boardId, error: String(err) });
    }
  }
  if (!endCol) {
    try {
      endCol = await client.createColumn(boardId, TIMESHEET_END_COLUMN_TITLE, 'date');
    } catch (err) {
      context.logger.warn('Failed to create Timesheet End column', { boardId, error: String(err) });
    }
  }

  const result: MondayBoardColumns = {
    dateStartId: startCol?.id,
    dateEndId: endCol?.id,
    personId: peopleColumns[0]?.id
  };

  if (result.dateStartId && result.dateEndId) {
    await context.state.set(cacheKey, result);
  }
  return result;
}

interface RawColumnValue {
  date?: string;
  time?: string | null;
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

function parseDate(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
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
