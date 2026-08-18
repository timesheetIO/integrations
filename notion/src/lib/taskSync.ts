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
import { NotionClient, richTextToPlain } from './notionClient';
import {
  NotionConfig,
  NotionPage,
  NotionPropertySchema,
  NotionPropertyValue,
  NotionWebhookPayload,
  ResolvedDatabaseProps,
  SyncInput
} from './types';

const SYSTEM = 'notion';
const PROJECT_ENTITY = 'project';
const TODO_ENTITY = 'todo';
const TASK_ENTITY = 'task';
const USER_ENTITY = 'user';
const SYNC_STATE_KEY = 'notion:last-sync-time';
const WEBHOOK_SECRET_STATE_KEY = 'notion:webhook-secret';
// Import locks close the webhook-vs-full-sync race on first import; held for
// the TTL (not released on success) so duplicate deliveries stay suppressed
// until the new mapping is visible everywhere.
const IMPORT_LOCK_TTL_SECONDS = 60 * 60;

const TODO_STATUS_OPEN = 0;
const TODO_STATUS_CLOSED = 1;

export interface NotionSyncResult {
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

/**
 * The optional Timesheet user ↔ Notion user mapping, keyed both ways.
 * `configured` is false on installations that never mapped anyone, which is the
 * normal single-user case and keeps the previous behavior.
 */
export interface UserMappingIndex {
  localToExternal: Map<string, string>;
  externalToLocal: Map<string, string>;
  configured: boolean;
}

/**
 * Reads the user mapping once per invocation. Organization installs run their
 * inbound work as the installing admin, so without this every member's Notion
 * time would be booked on that admin.
 */
export async function loadUserMappingIndex(
  context: IntegrationContext<NotionConfig>
): Promise<UserMappingIndex> {
  let records: MappingRecord[] = [];
  try {
    records = await context.mappings.list({ system: SYSTEM, entity: USER_ENTITY });
  } catch (err) {
    context.logger.warn('Failed to load Notion user mappings', { error: String(err) });
  }

  const localToExternal = new Map<string, string>();
  const externalToLocal = new Map<string, string>();
  for (const record of records) {
    if (!record.localId || !record.externalId) continue;
    localToExternal.set(record.localId, record.externalId);
    // Two Timesheet users may point at one Notion user; the first wins inbound
    // so imports stay deterministic.
    if (!externalToLocal.has(normalizeId(record.externalId))) {
      externalToLocal.set(normalizeId(record.externalId), record.localId);
    }
  }

  return { localToExternal, externalToLocal, configured: localToExternal.size > 0 };
}

let sharedClient: NotionClient | null = null;

export function resetSharedClient(): void {
  sharedClient = null;
}

export function createNotionClient(context: IntegrationContext<NotionConfig>): NotionClient {
  return new NotionClient({
    getAccessToken: () => context.credentials.getAccessToken(SYSTEM),
    refreshAccessToken: () => context.credentials.refreshToken(SYSTEM)
  });
}

function getOrCreateClient(context: IntegrationContext<NotionConfig>): NotionClient {
  if (!sharedClient) {
    sharedClient = createNotionClient(context);
  }
  return sharedClient;
}

// ============================================================================
// Property discovery (monday board-columns pattern)
// ============================================================================

function databasePropsCacheKey(databaseId: string): string {
  return `notion:db-props:${databaseId}`;
}

/**
 * Resolve the property names of a database from its schema and cache the
 * result in plugin state. Config overrides (statusProperty/dueDateProperty)
 * win when they name an existing property.
 */
export async function resolveDatabaseProps(
  context: IntegrationContext<NotionConfig>,
  client: NotionClient,
  databaseId: string
): Promise<ResolvedDatabaseProps | null> {
  const cacheKey = databasePropsCacheKey(databaseId);
  const cached = await context.state.get<ResolvedDatabaseProps>(cacheKey);
  if (cached?.titleName) {
    return cached;
  }

  const database = await client.getDatabase(databaseId);
  if (!database?.properties) {
    return null;
  }

  const entries = Object.entries(database.properties);
  const byType = (type: string): [string, NotionPropertySchema] | undefined =>
    entries.find(([, schema]) => schema?.type === type);

  const title = byType('title');
  if (!title) {
    return null;
  }

  const resolved: ResolvedDatabaseProps = { titleName: title[0] };

  // Status: config override by name, else first status property, else first
  // checkbox. Status options come from the schema's Complete/To-do groups.
  const statusOverride = context.config?.statusProperty;
  const statusEntry =
    (statusOverride && entries.find(([name]) => name === statusOverride)) ||
    byType('status') ||
    byType('checkbox');
  if (statusEntry) {
    const [statusName, statusSchema] = statusEntry;
    if (statusSchema.type === 'checkbox') {
      resolved.statusName = statusName;
      resolved.statusType = 'checkbox';
    } else if (statusSchema.type === 'status') {
      const options = statusSchema.status?.options ?? [];
      const groups = statusSchema.status?.groups ?? [];
      const optionById = new Map(options.map((option) => [option.id ?? '', option]));
      const completeGroup = groups.find((group) => (group.name ?? '').toLowerCase() === 'complete');
      const todoGroup = groups.find((group) => (group.name ?? '').toLowerCase() === 'to-do');
      const doneOption =
        optionById.get(completeGroup?.option_ids?.[0] ?? '')?.name ??
        options.find((option) => /^(done|complete|completed)$/i.test(option.name ?? ''))?.name;
      const openOption = optionById.get(todoGroup?.option_ids?.[0] ?? '')?.name ?? options[0]?.name;
      resolved.statusName = statusName;
      resolved.statusType = 'status';
      if (doneOption) {
        resolved.doneOption = doneOption;
      }
      if (openOption) {
        resolved.openOption = openOption;
      }
      const completeIds = (completeGroup?.option_ids ?? []).filter((id): id is string => !!id);
      if (completeIds.length > 0) {
        resolved.completeOptionIds = completeIds;
      }
    }
  }

  const dateOverride = context.config?.dueDateProperty;
  const dateEntry =
    (dateOverride && entries.find(([name, schema]) => name === dateOverride && schema?.type === 'date')) ||
    byType('date');
  if (dateEntry) {
    resolved.dateName = dateEntry[0];
  }

  const numberEntry = byType('number');
  if (numberEntry) {
    resolved.numberName = numberEntry[0];
  }
  const relationEntry = byType('relation');
  if (relationEntry) {
    resolved.relationName = relationEntry[0];
  }

  await context.state.set(cacheKey, resolved);
  return resolved;
}

// ============================================================================
// Outbound: Timesheet ToDo  →  Notion page
// ============================================================================

export async function syncTodoToNotion(
  input: SyncInput,
  context: IntegrationContext<NotionConfig>,
  caches?: SyncBatchCaches
): Promise<NotionSyncResult> {
  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  if (syncDirection === 'notion-to-timesheet' || syncDirection === 'external-to-timesheet') {
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

  const client = getOrCreateClient(context);
  const todoMapping = await getMapping(context, caches?.todoMappingByLocalId, TODO_ENTITY, todo.id);

  if (todo.deleted) {
    if (todoMapping?.externalId) {
      try {
        await client.archivePage(todoMapping.externalId);
      } catch (err) {
        if (!String(err).includes('(404)')) {
          context.logger.warn('Failed to archive Notion page for deleted todo', {
            externalId: todoMapping.externalId,
            error: String(err)
          });
        }
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

  const projectId = todo.project?.id;
  if (!projectId) {
    return skip({ reason: 'missing-project', todoId });
  }

  const projectMapping = await getMapping(context, caches?.projectMappingByLocalId, PROJECT_ENTITY, projectId);
  if (!projectMapping?.externalId) {
    return skip({ reason: 'missing-project-mapping', projectId });
  }

  const props = await resolveDatabaseProps(context, client, projectMapping.externalId);
  if (!props) {
    return skip({ reason: 'database-schema-unavailable', databaseId: projectMapping.externalId });
  }

  const properties = buildTodoPageProperties(todo, props);

  let external: NotionPage;
  if (todoMapping?.externalId) {
    const existing = await client.getPage(todoMapping.externalId);
    if (existing?.id && !isPageGone(existing)) {
      external = await client.updatePage(existing.id, properties);
    } else {
      external = await client.createPage(projectMapping.externalId, properties);
    }
  } else {
    external = await client.createPage(projectMapping.externalId, properties);
  }

  const upserted: MappingRecord = {
    localId: todo.id,
    externalId: external.id,
    externalLabel: todo.name ?? todo.id,
    metadata: {
      databaseId: projectMapping.externalId,
      localProjectId: projectId,
      ...syncMetadataStamp({
        localLastUpdateMillis: getLastUpdateMillis(todo),
        externalUpdatedAt: external.last_edited_time,
        externalUpdatedKey: 'lastEditedTime'
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
    details: { todoId: todo.id, externalPageId: external.id }
  };
}

// ============================================================================
// Outbound: Timesheet Task (time entry)  →  Notion time-log page
// ============================================================================

export async function syncTaskToNotion(
  input: SyncInput,
  context: IntegrationContext<NotionConfig>,
  caches?: SyncBatchCaches
): Promise<NotionSyncResult> {
  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  if (syncDirection === 'notion-to-timesheet' || syncDirection === 'external-to-timesheet') {
    return skip({ reason: 'sync-direction-mismatch' });
  }

  const timeLogDatabaseId = context.config?.timeLogDatabaseId;
  if (!timeLogDatabaseId) {
    return skip({ reason: 'time-log-database-not-configured' });
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

  if (task.deleted) {
    if (taskMapping?.externalId) {
      try {
        await client.archivePage(taskMapping.externalId);
      } catch (err) {
        if (!String(err).includes('(404)')) {
          context.logger.warn('Failed to archive Notion time-log page', {
            externalId: taskMapping.externalId,
            error: String(err)
          });
        }
      }
      await context.mappings.delete({ system: SYSTEM, entity: TASK_ENTITY, localId: task.id });
      caches?.taskMappingByLocalId?.delete(task.id);
      return { system: SYSTEM, status: 'deleted', syncedCount: 1 };
    }
    return skip({ reason: 'already-deleted' });
  }

  // Echo guard: skip the event fired by our own inbound import/update.
  if (taskMapping?.externalId && isAlreadySyncedLocalChange(taskMapping.metadata, getLastUpdateMillis(task))) {
    return skip({ reason: 'already-synced-task-change', taskId: task.id });
  }

  const start = parseDate(task.startDateTime);
  const end = parseDate(task.endDateTime);
  if (!start || !end) {
    return skip({ reason: 'invalid-task-dates', taskId: task.id });
  }

  const props = await resolveDatabaseProps(context, client, timeLogDatabaseId);
  if (!props) {
    return skip({ reason: 'time-log-schema-unavailable', databaseId: timeLogDatabaseId });
  }

  // The related todo's Notion page, when the task is attached to a mapped todo
  // and the time-log database has a relation property.
  let todoPageId: string | undefined;
  const localTodoId = task.todo?.id;
  if (localTodoId && props.relationName) {
    const todoMapping = await getMapping(context, caches?.todoMappingByLocalId, TODO_ENTITY, localTodoId);
    todoPageId = todoMapping?.externalId ?? undefined;
  }

  const properties = buildTimeLogPageProperties(task, start, end, props, todoPageId);

  let external: NotionPage;
  if (taskMapping?.externalId) {
    const existing = await client.getPage(taskMapping.externalId);
    if (existing?.id && !isPageGone(existing)) {
      external = await client.updatePage(existing.id, properties);
    } else {
      external = await client.createPage(timeLogDatabaseId, properties);
    }
  } else {
    external = await client.createPage(timeLogDatabaseId, properties);
  }

  const upserted: MappingRecord = {
    localId: task.id,
    externalId: external.id,
    externalLabel: task.description ?? task.id,
    metadata: {
      databaseId: timeLogDatabaseId,
      ...(todoPageId ? { todoPageId } : {}),
      ...(localTodoId ? { todoId: localTodoId } : {}),
      ...syncMetadataStamp({
        localLastUpdateMillis: getLastUpdateMillis(task),
        externalUpdatedAt: external.last_edited_time,
        externalUpdatedKey: 'lastEditedTime'
      })
    },
    syncStatus: 'SYNCED'
  };

  await context.mappings.upsert({ system: SYSTEM, entity: TASK_ENTITY, ...upserted });
  caches?.taskMappingByLocalId?.set(task.id, upserted);

  return {
    system: SYSTEM,
    status: 'synced',
    syncedCount: 1,
    details: { taskId: task.id, externalPageId: external.id }
  };
}

// ============================================================================
// Inbound: Notion  →  Timesheet (full sync + webhook handler)
// ============================================================================

export async function runNotionFullSync(
  context: IntegrationContext<NotionConfig>
): Promise<NotionSyncResult> {
  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  const allowInbound = syncDirection !== 'timesheet-to-notion' && syncDirection !== 'timesheet-to-external';

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
  const client = getOrCreateClient(context);

  let syncedCount = 0;
  for (const mapping of projectMappings) {
    if (!mapping.externalId) continue;
    const props = await resolveDatabaseProps(context, client, mapping.externalId);
    if (!props) continue;
    const pages = await client.queryDatabase(mapping.externalId, { editedSinceIso: lastSyncTime });
    for (const page of pages) {
      const synced = await upsertLocalTodoFromNotionPage(context, page, mapping.externalId, projectByExternalId, props);
      if (synced) syncedCount += 1;
    }
  }

  // Time-log database (v2): pull inbound edits to time entries as well.
  const timeLogDatabaseId = context.config?.timeLogDatabaseId;
  if (timeLogDatabaseId) {
    const props = await resolveDatabaseProps(context, client, timeLogDatabaseId);
    if (props) {
      const users = await loadUserMappingIndex(context);
      const pages = await client.queryDatabase(timeLogDatabaseId, { editedSinceIso: lastSyncTime });
      for (const page of pages) {
        const synced = await upsertLocalTaskFromNotionPage(context, page, props, users);
        if (synced) syncedCount += 1;
      }
    }
  }

  await context.state.set(SYNC_STATE_KEY, startedAt);

  return {
    system: SYSTEM,
    status: 'completed',
    syncedCount,
    details: { syncDirection, sinceIso: lastSyncTime ?? null, mappedDatabases: projectMappings.length }
  };
}

export async function handleNotionWebhook(
  input: SyncInput,
  context: IntegrationContext<NotionConfig>
): Promise<NotionSyncResult> {
  const payload = parseWebhookPayload(input.body, getRawBody(input));

  // Subscription handshake: the first delivery carries only a
  // verification_token, which becomes the HMAC secret for all later events.
  const verificationToken = payload?.verification_token;
  if (typeof verificationToken === 'string' && verificationToken.length > 0) {
    await context.state.set(WEBHOOK_SECRET_STATE_KEY, verificationToken);
    return { system: SYSTEM, status: 'handshake', syncedCount: 0, details: { hasToken: true } };
  }

  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  if (syncDirection === 'timesheet-to-notion' || syncDirection === 'timesheet-to-external') {
    return skip({ reason: 'sync-direction-mismatch' });
  }

  // The backend may have already verified and routed the delivery (Notion
  // webhooks are app-level: one URL per integration, routed by workspace_id).
  // Otherwise fail closed unless we hold the verification token.
  if (input?.verified !== true) {
    const secret = (await context.state.get<string>(WEBHOOK_SECRET_STATE_KEY)) ?? context.config?.webhookSecret;
    const signature = getHeader(input, 'x-notion-signature');
    const rawBody = getRawBody(input);
    if (!secret) {
      return { system: SYSTEM, status: 'rejected', syncedCount: 0, details: { reason: 'not-verified' } };
    }
    if (!signature || !rawBody) {
      return { system: SYSTEM, status: 'rejected', syncedCount: 0, details: { reason: 'missing-signature-or-body' } };
    }
    if (!(await verifyNotionSignature(rawBody, signature, secret))) {
      context.logger.warn('Notion webhook rejected: signature mismatch');
      return { system: SYSTEM, status: 'rejected', syncedCount: 0, details: { reason: 'invalid-signature' } };
    }
  }

  const eventType = payload?.type;
  const pageId = payload?.entity?.id;
  if (!eventType || !pageId || payload?.entity?.type !== 'page') {
    return { system: SYSTEM, status: 'ignored', syncedCount: 0, details: { reason: 'no-page-event' } };
  }

  if (eventType === 'page.deleted') {
    const removed = await deleteLocalByExternalPageId(context, pageId);
    return {
      system: SYSTEM,
      status: 'completed',
      syncedCount: removed ? 1 : 0,
      details: { eventType, pageId }
    };
  }

  return syncPageInbound(context, pageId);
}

export async function syncTodoFromNotion(
  input: SyncInput,
  context: IntegrationContext<NotionConfig>
): Promise<NotionSyncResult> {
  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  if (syncDirection === 'timesheet-to-notion' || syncDirection === 'timesheet-to-external') {
    return skip({ reason: 'sync-direction-mismatch' });
  }
  const externalTaskId = input?.externalTaskId;
  if (!externalTaskId) {
    return skip({ reason: 'missing-external-task-id' });
  }
  return syncPageInbound(context, externalTaskId);
}

// One inbound page: fetch it, then route by parent database — time-log rows
// become Timesheet tasks, everything else todos.
async function syncPageInbound(
  context: IntegrationContext<NotionConfig>,
  pageId: string
): Promise<NotionSyncResult> {
  const client = getOrCreateClient(context);
  const page = await client.getPage(pageId);

  if (!page || isPageGone(page)) {
    const removed = await deleteLocalByExternalPageId(context, pageId);
    return {
      system: SYSTEM,
      status: 'completed',
      syncedCount: removed ? 1 : 0,
      details: { pageId, reason: removed ? 'deleted-archived-page' : 'page-not-found' }
    };
  }

  const parentDatabaseId = page.parent?.database_id;
  const timeLogDatabaseId = context.config?.timeLogDatabaseId;

  if (timeLogDatabaseId && parentDatabaseId && normalizeId(parentDatabaseId) === normalizeId(timeLogDatabaseId)) {
    const props = await resolveDatabaseProps(context, client, timeLogDatabaseId);
    if (!props) {
      return skip({ reason: 'time-log-schema-unavailable', pageId });
    }
    const users = await loadUserMappingIndex(context);
    const synced = await upsertLocalTaskFromNotionPage(context, page, props, users);
    return { system: SYSTEM, status: 'completed', syncedCount: synced ? 1 : 0, details: { pageId, kind: 'task' } };
  }

  const projectMappings = await context.mappings.list({ system: SYSTEM, entity: PROJECT_ENTITY });
  const projectByExternalId = new Map(projectMappings.map((m) => [m.externalId, m.localId]));
  const databaseMapping = parentDatabaseId
    ? projectMappings.find((m) => normalizeId(m.externalId) === normalizeId(parentDatabaseId))
    : undefined;
  if (!databaseMapping?.externalId) {
    return skip({ reason: 'unmapped-database', pageId, parentDatabaseId: parentDatabaseId ?? null });
  }

  const props = await resolveDatabaseProps(context, client, databaseMapping.externalId);
  if (!props) {
    return skip({ reason: 'database-schema-unavailable', pageId });
  }

  const synced = await upsertLocalTodoFromNotionPage(context, page, databaseMapping.externalId, projectByExternalId, props);
  return { system: SYSTEM, status: 'completed', syncedCount: synced ? 1 : 0, details: { pageId, kind: 'todo' } };
}

async function upsertLocalTodoFromNotionPage(
  context: IntegrationContext<NotionConfig>,
  page: NotionPage,
  databaseId: string,
  projectByExternalId: Map<string, string>,
  props: ResolvedDatabaseProps
): Promise<boolean> {
  if (!page?.id || isPageGone(page)) return false;

  const localProjectId = projectByExternalId.get(databaseId);
  if (!localProjectId) return false;

  const name = readTitle(page, props) || `Notion page ${page.id}`;
  const status = readStatus(page, props);
  const dueDate = readDueDate(page, props);

  const todoMapping = await context.mappings.findByExternal({
    system: SYSTEM,
    entity: TODO_ENTITY,
    externalId: page.id
  });

  if (!todoMapping?.localId) {
    const lockKey = `import:todo:${page.id}`;
    if (!(await tryAcquireStateLock(context.state, lockKey, IMPORT_LOCK_TTL_SECONDS))) {
      context.logger.info('Notion todo import already in progress, skipping duplicate create', {
        externalId: page.id
      });
      return false;
    }

    let created: ToDoDto;
    try {
      created = await context.data.createTodo({
        projectId: localProjectId,
        name,
        status,
        dueDate
      } as ToDoCreateInput);
    } catch (err) {
      await releaseStateLock(context.state, lockKey);
      throw err;
    }

    await upsertTodoMapping(context, created.id, page, databaseId, localProjectId, name, getLastUpdateMillis(created));
    return true;
  }

  // Echo guard. Caveat: Notion truncates last_edited_time to the minute, so a
  // genuine external edit inside the same minute as our own write compares
  // stale and is picked up by a later edit or the scheduled full sync.
  if (isStaleExternalChange({
    metadata: todoMapping.metadata,
    metadataKey: 'lastEditedTime',
    externalUpdatedAt: page.last_edited_time
  })) {
    return false;
  }

  const existing = await context.data.getTodo(todoMapping.localId);
  if (isStaleExternalChange({
    externalUpdatedAt: page.last_edited_time,
    localLastUpdateMillis: getLastUpdateMillis(existing)
  })) {
    return false;
  }

  const updated = await context.data.updateTodo(todoMapping.localId, {
    name,
    status,
    dueDate
  } as ToDoUpdateInput);

  await upsertTodoMapping(context, todoMapping.localId, page, databaseId, localProjectId, name, getLastUpdateMillis(updated));
  return true;
}

async function upsertLocalTaskFromNotionPage(
  context: IntegrationContext<NotionConfig>,
  page: NotionPage,
  props: ResolvedDatabaseProps,
  users: UserMappingIndex
): Promise<boolean> {
  if (!page?.id || isPageGone(page)) return false;

  // The related todo page carries the project context; a time-log row without
  // a mapped todo relation has nothing local to attach to.
  const relatedPageId = props.relationName
    ? page.properties?.[props.relationName]?.relation?.[0]?.id
    : undefined;
  if (!relatedPageId) return false;

  const todoMapping = await context.mappings.findByExternal({
    system: SYSTEM,
    entity: TODO_ENTITY,
    externalId: relatedPageId
  });
  if (!todoMapping?.localId) return false;

  const localProjectId = readMetadataString(todoMapping.metadata ?? {}, 'localProjectId');
  if (!localProjectId) return false;

  const dateRange = readTimeLogDateRange(page, props);
  if (!dateRange) return false;

  const description = readTitle(page, props);

  const externalUserId = page.created_by?.id ? normalizeId(page.created_by.id) : undefined;
  const localUserId = externalUserId ? users.externalToLocal.get(externalUserId) : undefined;
  if (users.configured && !localUserId) {
    // An installation that maps users expects per-member attribution. Importing
    // an unmapped person's time would book it on whoever the inbound sync runs
    // as, which on an organization install is the installing admin.
    context.logger.info('Skipping Notion time log for an unmapped user', {
      pageId: page.id,
      notionUserId: externalUserId
    });
    return false;
  }

  const taskMapping = await context.mappings.findByExternal({
    system: SYSTEM,
    entity: TASK_ENTITY,
    externalId: page.id
  });

  if (!taskMapping?.localId) {
    const lockKey = `import:task:${page.id}`;
    if (!(await tryAcquireStateLock(context.state, lockKey, IMPORT_LOCK_TTL_SECONDS))) {
      context.logger.info('Notion time-log import already in progress, skipping duplicate create', {
        externalId: page.id
      });
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
        // The backend drops userId when the acting profile has no team features
        // and books the task on itself instead.
        context.logger.error('Notion time log was booked on the wrong member', {
          pageId: page.id,
          requestedUserId: localUserId,
          actualUserId: created.user
        });
      }
    } catch (err) {
      await releaseStateLock(context.state, lockKey);
      throw err;
    }

    await upsertTaskMappingInbound(context, created.id, page, todoMapping.localId, relatedPageId, getLastUpdateMillis(created));
    return true;
  }

  if (isStaleExternalChange({
    metadata: taskMapping.metadata,
    metadataKey: 'lastEditedTime',
    externalUpdatedAt: page.last_edited_time
  })) {
    return false;
  }

  const existing = await context.data.getTask(taskMapping.localId);
  if (isStaleExternalChange({
    externalUpdatedAt: page.last_edited_time,
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

  await upsertTaskMappingInbound(context, taskMapping.localId, page, todoMapping.localId, relatedPageId, getLastUpdateMillis(updated));
  return true;
}

async function deleteLocalByExternalPageId(
  context: IntegrationContext<NotionConfig>,
  externalId: string
): Promise<boolean> {
  const todoMapping = await context.mappings.findByExternal({
    system: SYSTEM,
    entity: TODO_ENTITY,
    externalId
  });
  if (todoMapping?.localId) {
    try {
      await context.data.deleteTodo(todoMapping.localId);
    } catch (err) {
      context.logger.warn('Failed to delete local todo for Notion page delete', {
        localId: todoMapping.localId,
        externalId,
        error: String(err)
      });
    }
    await context.mappings.delete({ system: SYSTEM, entity: TODO_ENTITY, localId: todoMapping.localId });
    return true;
  }

  const taskMapping = await context.mappings.findByExternal({
    system: SYSTEM,
    entity: TASK_ENTITY,
    externalId
  });
  if (taskMapping?.localId) {
    try {
      await context.data.deleteTask(taskMapping.localId);
    } catch (err) {
      context.logger.warn('Failed to delete local task for Notion page delete', {
        localId: taskMapping.localId,
        externalId,
        error: String(err)
      });
    }
    await context.mappings.delete({ system: SYSTEM, entity: TASK_ENTITY, localId: taskMapping.localId });
    return true;
  }

  return false;
}

// ============================================================================
// Property build / read helpers
// ============================================================================

function buildTodoPageProperties(todo: ToDoDto, props: ResolvedDatabaseProps): Record<string, unknown> {
  const name = todo.name?.trim() || `Todo ${todo.id}`;
  const closed = todo.status === TODO_STATUS_CLOSED;

  const properties: Record<string, unknown> = {
    [props.titleName]: { title: [{ type: 'text', text: { content: name } }] }
  };

  if (props.statusName) {
    if (props.statusType === 'checkbox') {
      properties[props.statusName] = { checkbox: closed };
    } else if (props.statusType === 'status') {
      const option = closed ? props.doneOption : props.openOption;
      if (option) {
        properties[props.statusName] = { status: { name: option } };
      }
    }
  }

  if (props.dateName && todo.dueDate) {
    properties[props.dateName] = { date: { start: todo.dueDate.slice(0, 10) } };
  }

  return properties;
}

function buildTimeLogPageProperties(
  task: TaskDto,
  start: Date,
  end: Date,
  props: ResolvedDatabaseProps,
  todoPageId: string | undefined
): Record<string, unknown> {
  const title = task.description?.trim() || `Time entry ${start.toISOString().slice(0, 10)}`;

  const properties: Record<string, unknown> = {
    [props.titleName]: { title: [{ type: 'text', text: { content: title } }] }
  };

  if (props.dateName) {
    properties[props.dateName] = {
      date: { start: start.toISOString(), end: end.toISOString() }
    };
  }

  if (props.numberName) {
    properties[props.numberName] = { number: computeHours(task, start, end) };
  }

  if (props.relationName && todoPageId) {
    properties[props.relationName] = { relation: [{ id: todoPageId }] };
  }

  return properties;
}

// Net worked hours: duration/durationBreak are seconds (see the platform-wide
// `duration - durationBreak` convention).
function computeHours(task: TaskDto, start: Date, end: Date): number {
  const breakSeconds = Number(task.durationBreak ?? 0);
  const safeBreak = Number.isFinite(breakSeconds) && breakSeconds > 0 ? breakSeconds : 0;
  const gross = Number(task.duration);
  const netSeconds = Number.isFinite(gross) && gross > 0
    ? Math.max(0, gross - safeBreak)
    : Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000) - safeBreak);
  return Math.round((netSeconds / 3600) * 100) / 100;
}

function readTitle(page: NotionPage, props: ResolvedDatabaseProps): string {
  const value = page.properties?.[props.titleName];
  return richTextToPlain(value?.title);
}

function readStatus(page: NotionPage, props: ResolvedDatabaseProps): number {
  if (!props.statusName) return TODO_STATUS_OPEN;
  const value = page.properties?.[props.statusName];
  if (props.statusType === 'checkbox') {
    return value?.checkbox === true ? TODO_STATUS_CLOSED : TODO_STATUS_OPEN;
  }
  if (props.statusType === 'status') {
    const optionId = value?.status?.id ?? '';
    const optionName = value?.status?.name ?? '';
    if (props.completeOptionIds?.includes(optionId)) return TODO_STATUS_CLOSED;
    if (props.doneOption && optionName === props.doneOption) return TODO_STATUS_CLOSED;
  }
  return TODO_STATUS_OPEN;
}

function readDueDate(page: NotionPage, props: ResolvedDatabaseProps): string | undefined {
  if (!props.dateName) return undefined;
  const start = page.properties?.[props.dateName]?.date?.start;
  return start ? start.slice(0, 10) : undefined;
}

function readTimeLogDateRange(
  page: NotionPage,
  props: ResolvedDatabaseProps
): { startDateTime: string; endDateTime: string } | null {
  if (!props.dateName) return null;
  const value = page.properties?.[props.dateName]?.date;
  const start = parseDate(value?.start ?? undefined);
  if (!start) return null;
  const end = parseDate(value?.end ?? undefined) ?? start;
  return { startDateTime: toApiDateTime(start), endDateTime: toApiDateTime(end) };
}

// ============================================================================
// Mapping upserts
// ============================================================================

async function upsertTodoMapping(
  context: IntegrationContext<NotionConfig>,
  localId: string,
  page: NotionPage,
  databaseId: string,
  localProjectId: string,
  name: string,
  localLastUpdateMillis: number
): Promise<void> {
  await context.mappings.upsert({
    system: SYSTEM,
    entity: TODO_ENTITY,
    localId,
    externalId: page.id,
    externalLabel: name,
    metadata: {
      databaseId,
      localProjectId,
      ...syncMetadataStamp({
        localLastUpdateMillis,
        externalUpdatedAt: page.last_edited_time,
        externalUpdatedKey: 'lastEditedTime'
      })
    },
    syncStatus: 'SYNCED'
  });
}

async function upsertTaskMappingInbound(
  context: IntegrationContext<NotionConfig>,
  localId: string,
  page: NotionPage,
  localTodoId: string,
  todoPageId: string,
  localLastUpdateMillis: number
): Promise<void> {
  await context.mappings.upsert({
    system: SYSTEM,
    entity: TASK_ENTITY,
    localId,
    externalId: page.id,
    externalLabel: readTitleSafe(page),
    metadata: {
      databaseId: page.parent?.database_id ?? '',
      todoId: localTodoId,
      todoPageId,
      ...syncMetadataStamp({
        localLastUpdateMillis,
        externalUpdatedAt: page.last_edited_time,
        externalUpdatedKey: 'lastEditedTime'
      })
    },
    syncStatus: 'SYNCED'
  });
}

function readTitleSafe(page: NotionPage): string {
  for (const value of Object.values(page.properties ?? {})) {
    if (value?.type === 'title' || value?.title) {
      const text = richTextToPlain(value.title);
      if (text) return text;
    }
  }
  return page.id;
}

// ============================================================================
// Generic helpers
// ============================================================================

function isPageGone(page: NotionPage): boolean {
  return page.archived === true || page.in_trash === true;
}

// Notion ids appear both hyphenated and bare depending on the source (API vs
// pasted from a URL); compare canonicalized.
function normalizeId(id: string): string {
  return id.replace(/-/g, '').toLowerCase();
}

async function getMapping(
  context: IntegrationContext<NotionConfig>,
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
  context: IntegrationContext<NotionConfig>
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
  context: IntegrationContext<NotionConfig>
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

// The Timesheet API datetime format is `yyyy-MM-dd'T'HH:mm:ssxxx`; emit an
// explicit +00:00 offset rather than a trailing 'Z' (which the API rejects).
function toApiDateTime(date: Date): string {
  return `${date.toISOString().slice(0, 19)}+00:00`;
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
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
  if (!key) return undefined;
  const value = headers[key];
  return value === undefined || value === null ? undefined : String(value);
}

function getRawBody(input: SyncInput): string | undefined {
  if (typeof input?.rawBody === 'string' && input.rawBody.length > 0) return input.rawBody;
  if (typeof input?.body === 'string' && input.body.length > 0) return input.body;
  // Reconstructing JSON only matches the HMAC if the runtime serialized the
  // parsed body identically to the request bytes — it typically doesn't, so
  // verification fails closed downstream.
  if (input?.body && typeof input.body === 'object') {
    try {
      return JSON.stringify(input.body);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseWebhookPayload(body: unknown, rawBody: string | undefined): NotionWebhookPayload | null {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return body as NotionWebhookPayload;
  }
  if (rawBody) {
    try {
      return JSON.parse(rawBody) as NotionWebhookPayload;
    } catch {
      return null;
    }
  }
  return null;
}

// Web Crypto is used so this plugin works in sandboxed runtimes (esbuild bundler
// without Node built-ins). Both Node 18+ and the plugin runtime expose
// `globalThis.crypto.subtle`.
async function verifyNotionSignature(rawBody: string, signatureHeader: string, secret: string): Promise<boolean> {
  // Notion signs the raw request body with HMAC-SHA256 keyed on the
  // verification token, sent as `X-Notion-Signature: sha256=<hex>`.
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const expected = `sha256=${bufferToHex(signatureBuffer)}`;
  const provided = signatureHeader.startsWith('sha256=') ? signatureHeader : `sha256=${signatureHeader}`;
  return constantTimeEquals(expected, provided);
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

function skip(details: Record<string, unknown>): NotionSyncResult {
  return { system: SYSTEM, status: 'skipped', syncedCount: 0, details };
}
