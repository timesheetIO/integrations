import * as crypto from 'crypto';
import {
  IntegrationContext,
  MappingRecord,
  TaskCreateInput,
  TaskDto,
  TaskUpdateInput
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
const USER_ENTITY = 'user';
const SYNC_STATE_KEY = 'monday:last-sync-time';

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

  const boardId = projectMapping.externalId;
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
  if (taskMapping?.externalId) {
    try {
      external = await client.updateItem(taskMapping.externalId, boardId, name, columnValues);
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
    localId: task.id,
    externalId: external.id,
    externalLabel: external.name ?? task.description ?? task.id,
    metadata: {
      boardId,
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
    details: { taskId: task.id, externalTaskId: external.id }
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
  const sinceMs = await context.state.get<number>(SYNC_STATE_KEY);
  const startedAt = Date.now();
  let syncedCount = 0;

  for (const mapping of projectMappings) {
    const boardId = mapping.externalId;
    if (!boardId) {
      continue;
    }
    const items = await client.listItemsForBoard(boardId, { updatedSinceMs: sinceMs ?? undefined });
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

  if (!verifyMondaySignature(authHeader, secret)) {
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
        boardId: projectMapping.externalId ?? '',
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
  const boardId = String(hintedBoardId ?? external.board?.id ?? '');
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
  return input?.taskId || input?.item?.taskId || input?.item?.id;
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

function verifyMondaySignature(authHeader: string, secret: string): boolean {
  // monday.com signs webhook deliveries with a JWT (HS256) in the Authorization
  // header. Anything else is treated as invalid.
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const parts = token.split('.');
  if (parts.length !== 3) {
    return false;
  }
  const [headerB64, payloadB64, signatureB64] = parts;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signatureB64);
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}
