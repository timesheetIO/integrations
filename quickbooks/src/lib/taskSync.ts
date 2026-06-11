import {
  IntegrationContext,
  MappingRecord,
  TaskCreateInput,
  TaskDto,
  TaskUpdateInput
} from '@timesheet/integration-sdk';
import { QuickBooksClient } from './quickbooksClient';
import {
  QuickBooksCloudEvent,
  QuickBooksConfig,
  QuickBooksTimeActivity,
  QuickBooksWebhookPayload,
  SyncInput
} from './types';

const SYSTEM = 'quickbooks';
const PROJECT_ENTITY = 'project';
const USER_ENTITY = 'user';
const TASK_ENTITY = 'task';
const RATE_ENTITY = 'rate';
const SYNC_STATE_KEY = 'quickbooks:last-sync-time';

export interface QuickBooksSyncResult {
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

// Shared client per batch keyed by realmId — avoids re-fetching the access token
// and re-resolving the connection's realmId on every change. Reset between
// installations is the runtime's responsibility (each invocation gets a fresh
// module instance in the typical worker model).
let sharedClient: { realmId: string; client: QuickBooksClient } | null = null;

export function resetSharedClient(): void {
  sharedClient = null;
}

export async function syncTaskToQuickBooks(
  input: SyncInput,
  context: IntegrationContext<QuickBooksConfig>,
  caches?: SyncBatchCaches
): Promise<QuickBooksSyncResult> {
  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  if (syncDirection === 'qb-to-timesheet' || syncDirection === 'external-to-timesheet') {
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

  const localUserId = task.user ?? task.member?.uid;
  if (!localUserId) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'missing-user', taskId } };
  }

  const userMapping = await getMapping(context, caches?.userMappingByLocalId, USER_ENTITY, localUserId);
  if (!userMapping?.externalId) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'missing-user-mapping', userId: localUserId } };
  }

  const client = await getOrCreateClient(context, input?.realmId);
  const taskMapping = await getMapping(context, caches?.taskMappingByLocalId, TASK_ENTITY, task.id);

  if (task.deleted) {
    if (taskMapping?.externalId) {
      const existing = await client.getTimeActivity(taskMapping.externalId);
      if (existing?.Id && existing.SyncToken !== undefined) {
        await client.deleteTimeActivity(existing.Id, existing.SyncToken);
      }
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

  const rateId = task.rate?.id;
  const rateMapping = rateId
    ? await getMapping(context, caches?.rateMappingByLocalId, RATE_ENTITY, rateId)
    : null;
  const hourlyRate = await resolveHourlyRateForPush(task, context);

  let payload: Record<string, unknown>;
  try {
    payload = buildTimeActivityPayload(
      task,
      projectMapping.externalId,
      userMapping.externalId,
      rateMapping?.externalId,
      hourlyRate
    );
  } catch (err) {
    context.logger.warn('Failed to build time activity payload', { taskId: task.id, error: String(err) });
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'invalid-task-data', taskId: task.id } };
  }

  let external: QuickBooksTimeActivity;
  if (taskMapping?.externalId) {
    const existing = await client.getTimeActivity(taskMapping.externalId);
    if (existing?.Id && existing.SyncToken !== undefined) {
      external = await client.updateTimeActivity({
        ...payload,
        Id: existing.Id,
        SyncToken: existing.SyncToken,
        sparse: true
      });
    } else {
      external = await client.createTimeActivity(payload);
    }
  } else {
    external = await client.createTimeActivity(payload);
  }

  const upsertedMapping: MappingRecord = {
    localId: task.id,
    externalId: external.Id,
    externalLabel: task.description ?? task.id,
    metadata: {
      customerId: projectMapping.externalId,
      employeeId: userMapping.externalId,
      ...(rateMapping?.externalId ? { itemId: rateMapping.externalId } : {}),
      syncToken: external.SyncToken ?? '',
      txnDate: external.TxnDate ?? ''
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
    details: {
      taskId: task.id,
      externalTaskId: external.Id
    }
  };
}

export async function runQuickBooksFullSync(
  context: IntegrationContext<QuickBooksConfig>
): Promise<QuickBooksSyncResult> {
  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  const allowInbound = syncDirection !== 'timesheet-to-qb' && syncDirection !== 'timesheet-to-external';

  const projectMappings = await context.mappings.list({ system: SYSTEM, entity: PROJECT_ENTITY });
  const userMappings = await context.mappings.list({ system: SYSTEM, entity: USER_ENTITY });

  if (projectMappings.length === 0 || userMappings.length === 0) {
    return {
      system: SYSTEM,
      status: 'skipped',
      syncedCount: 0,
      details: {
        reason: projectMappings.length === 0 ? 'missing-project-mappings' : 'missing-user-mappings'
      }
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

  const rateMappings = await context.mappings.list({ system: SYSTEM, entity: RATE_ENTITY });
  const projectByExternalId = new Map(projectMappings.map((mapping) => [mapping.externalId, mapping.localId]));
  const userByExternalId = new Map(userMappings.map((mapping) => [mapping.externalId, mapping.localId]));
  const rateByExternalId = new Map(rateMappings.map((mapping) => [mapping.externalId, mapping.localId]));

  const lastSyncTime = (await context.state.get<string>(SYNC_STATE_KEY)) ?? undefined;
  const startedAt = new Date().toISOString();

  const client = await getOrCreateClient(context);
  const activities = await client.listTimeActivities({ sinceIso: lastSyncTime });

  let syncedCount = 0;
  for (const activity of activities) {
    const synced = await syncSingleExternalActivity(
      activity,
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
    details: { syncDirection, sinceIso: lastSyncTime ?? null, activityCount: activities.length }
  };
}

interface EntityChange {
  id: string;
  operation: string;
  realmId: string;
}

export async function handleQuickBooksWebhook(
  input: SyncInput,
  context: IntegrationContext<QuickBooksConfig>
): Promise<QuickBooksSyncResult> {
  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  if (syncDirection === 'timesheet-to-qb' || syncDirection === 'timesheet-to-external') {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'sync-direction-mismatch' } };
  }

  // App-level webhooks are verified and routed to the owning installation by the backend, which
  // holds the raw request body and the app verifier token. When that has happened we trust it and
  // process only the resolved realm. Otherwise fall back to verifying in-plugin (legacy path).
  const backendVerified = input?.verified === true;
  const rawBody = getRawBody(input);

  if (!backendVerified) {
    const verifierToken = context.config?.webhookVerifierToken;
    if (!verifierToken) {
      context.logger.warn('QuickBooks webhook rejected: webhookVerifierToken not configured');
      return { system: SYSTEM, status: 'rejected', syncedCount: 0, details: { reason: 'verifier-not-configured' } };
    }

    const signature = getHeader(input, 'intuit-signature');
    if (!signature) {
      return { system: SYSTEM, status: 'rejected', syncedCount: 0, details: { reason: 'missing-signature' } };
    }

    if (!rawBody) {
      return { system: SYSTEM, status: 'rejected', syncedCount: 0, details: { reason: 'missing-body' } };
    }

    if (!(await verifyIntuitSignature(rawBody, signature, verifierToken))) {
      context.logger.warn('QuickBooks webhook rejected: signature mismatch');
      return { system: SYSTEM, status: 'rejected', syncedCount: 0, details: { reason: 'invalid-signature' } };
    }
  }

  const payload = parseWebhookPayload(input.body, rawBody ?? '');
  let changes = collectChangesFromPayload(payload);

  // The backend dispatches one execution per realm, so ignore any other realm sharing the payload.
  if (backendVerified && input?.realmId) {
    changes = changes.filter((change) => change.realmId === input.realmId);
  }

  return processInboundChanges(changes, context);
}

export async function syncTaskFromQuickBooks(
  input: SyncInput,
  context: IntegrationContext<QuickBooksConfig>
): Promise<QuickBooksSyncResult> {
  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  if (syncDirection === 'timesheet-to-qb' || syncDirection === 'timesheet-to-external') {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'sync-direction-mismatch' } };
  }

  const externalTaskId = input?.externalTaskId;
  if (!externalTaskId) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'missing-external-task-id' } };
  }

  const realmId = input?.realmId
    ?? (await context.credentials.getConnectionInfo(SYSTEM))?.accountId;
  if (!realmId) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'missing-realm-id' } };
  }

  return processInboundChanges(
    [{ id: externalTaskId, operation: 'update', realmId }],
    context
  );
}

async function processInboundChanges(
  changes: EntityChange[],
  context: IntegrationContext<QuickBooksConfig>
): Promise<QuickBooksSyncResult> {
  if (changes.length === 0) {
    return {
      system: SYSTEM,
      status: 'ignored',
      syncedCount: 0,
      details: { reason: 'no-time-activity-ids' }
    };
  }

  const projectMappings = await context.mappings.list({ system: SYSTEM, entity: PROJECT_ENTITY });
  const userMappings = await context.mappings.list({ system: SYSTEM, entity: USER_ENTITY });
  const rateMappings = await context.mappings.list({ system: SYSTEM, entity: RATE_ENTITY });
  const projectByExternalId = new Map(projectMappings.map((mapping) => [mapping.externalId, mapping.localId]));
  const userByExternalId = new Map(userMappings.map((mapping) => [mapping.externalId, mapping.localId]));
  const rateByExternalId = new Map(rateMappings.map((mapping) => [mapping.externalId, mapping.localId]));

  const byRealm = new Map<string, EntityChange[]>();
  for (const change of changes) {
    const list = byRealm.get(change.realmId) ?? [];
    list.push(change);
    byRealm.set(change.realmId, list);
  }

  let syncedCount = 0;
  for (const [realmId, realmChanges] of byRealm) {
    const client = await getOrCreateClient(context, realmId);
    for (const change of realmChanges) {
      if (isDeleteOperation(change.operation)) {
        const removed = await deleteLocalTaskByExternalId(context, change.id);
        if (removed) {
          syncedCount += 1;
        }
        continue;
      }

      const activity = await client.getTimeActivity(change.id);
      if (!activity) {
        continue;
      }

      const synced = await syncSingleExternalActivity(
        activity,
        context,
        projectByExternalId,
        userByExternalId,
        rateByExternalId
      );

      if (synced) {
        syncedCount += 1;
      }
    }
  }

  return {
    system: SYSTEM,
    status: 'completed',
    syncedCount,
    details: { entityCount: changes.length, realmCount: byRealm.size }
  };
}

function collectChangesFromPayload(events: QuickBooksWebhookPayload | null): EntityChange[] {
  const changes: EntityChange[] = [];
  for (const event of events ?? []) {
    const change = parseTimeActivityEvent(event);
    if (change) {
      changes.push(change);
    }
  }
  return changes;
}

// The plugin runtime injects the deployment environment as `context.environment`.
// 'sandbox' selects the QuickBooks sandbox API host; production runtimes default
// to the production host.
function isSandboxEnvironment(context: IntegrationContext<QuickBooksConfig>): boolean {
  return context.environment === 'sandbox';
}

export async function createQuickBooksClient(
  context: IntegrationContext<QuickBooksConfig>,
  realmOverride?: string
): Promise<QuickBooksClient> {
  let realmId = realmOverride;
  if (!realmId) {
    const connectionInfo = await context.credentials.getConnectionInfo(SYSTEM);
    realmId = connectionInfo?.accountId;
  }
  if (!realmId) {
    throw new Error('QuickBooks realmId/accountId missing. Complete OAuth first.');
  }
  return new QuickBooksClient({
    realmId,
    sandbox: isSandboxEnvironment(context),
    getAccessToken: () => context.credentials.getAccessToken(SYSTEM),
    refreshAccessToken: () => context.credentials.refreshToken(SYSTEM)
  });
}

async function getOrCreateClient(
  context: IntegrationContext<QuickBooksConfig>,
  realmOverride?: string
): Promise<QuickBooksClient> {
  if (realmOverride) {
    if (sharedClient && sharedClient.realmId === realmOverride) {
      return sharedClient.client;
    }
    const client = await createQuickBooksClient(context, realmOverride);
    sharedClient = { realmId: realmOverride, client };
    return client;
  }
  if (sharedClient) {
    return sharedClient.client;
  }
  const connectionInfo = await context.credentials.getConnectionInfo(SYSTEM);
  const realmId = connectionInfo?.accountId;
  if (!realmId) {
    throw new Error('QuickBooks realmId/accountId missing. Complete OAuth first.');
  }
  const client = await createQuickBooksClient(context, realmId);
  sharedClient = { realmId, client };
  return client;
}

async function syncSingleExternalActivity(
  activity: QuickBooksTimeActivity,
  context: IntegrationContext<QuickBooksConfig>,
  projectByExternalId: Map<string, string>,
  userByExternalId: Map<string, string>,
  rateByExternalId: Map<string, string>
): Promise<boolean> {
  if (!activity?.Id) {
    return false;
  }

  const externalProjectId = activity.CustomerRef?.value;
  const externalUserId = activity.EmployeeRef?.value;
  if (!externalProjectId || !externalUserId) {
    return false;
  }

  const localProjectId = projectByExternalId.get(externalProjectId);
  const localUserId = userByExternalId.get(externalUserId);
  if (!localProjectId || !localUserId) {
    return false;
  }

  // Only set the rate when the activity's service item is mapped — an absent or
  // unmapped ItemRef must not clear a locally assigned rate.
  const externalItemId = activity.ItemRef?.value;
  const localRateId = externalItemId ? rateByExternalId.get(externalItemId) : undefined;

  const dateRange = buildTaskDateRange(activity);
  if (!dateRange) {
    return false;
  }

  const taskMapping = await context.mappings.findByExternal({
    system: SYSTEM,
    entity: TASK_ENTITY,
    externalId: activity.Id
  });

  if (!taskMapping?.localId) {
    const created = await context.data.createTask({
      projectId: localProjectId,
      userId: localUserId,
      startDateTime: dateRange.startDateTime,
      endDateTime: dateRange.endDateTime,
      description: activity.Description ?? '',
      billable: isBillable(activity.BillableStatus),
      billed: isBilled(activity.BillableStatus),
      ...(localRateId ? { rateId: localRateId } : {})
    } as TaskCreateInput);

    await context.mappings.upsert({
      system: SYSTEM,
      entity: TASK_ENTITY,
      localId: created.id,
      externalId: activity.Id,
      externalLabel: activity.Description ?? activity.Id,
      metadata: {
        customerId: externalProjectId,
        employeeId: externalUserId,
        syncToken: activity.SyncToken ?? ''
      },
      syncStatus: 'SYNCED'
    });

    return true;
  }

  const existing = await context.data.getTask(taskMapping.localId);
  const externalUpdatedAt = getExternalUpdatedAt(activity);
  if (existing?.lastUpdate && externalUpdatedAt > 0 && externalUpdatedAt <= existing.lastUpdate) {
    return false;
  }

  await context.data.updateTask(taskMapping.localId, {
    projectId: localProjectId,
    startDateTime: dateRange.startDateTime,
    endDateTime: dateRange.endDateTime,
    description: activity.Description ?? '',
    billable: isBillable(activity.BillableStatus),
    billed: isBilled(activity.BillableStatus),
    ...(localRateId ? { rateId: localRateId } : {})
  } as TaskUpdateInput);

  await context.mappings.upsert({
    system: SYSTEM,
    entity: TASK_ENTITY,
    localId: taskMapping.localId,
    externalId: activity.Id,
    externalLabel: activity.Description ?? activity.Id,
    metadata: {
      customerId: externalProjectId,
      employeeId: externalUserId,
      syncToken: activity.SyncToken ?? ''
    },
    syncStatus: 'SYNCED'
  });

  return true;
}

async function deleteLocalTaskByExternalId(
  context: IntegrationContext<QuickBooksConfig>,
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
    context.logger.warn('Failed to delete local task for QuickBooks delete event', {
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

async function getMapping(
  context: IntegrationContext<QuickBooksConfig>,
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
  context: IntegrationContext<QuickBooksConfig>
): Promise<TaskDto | null> {
  // Prefer the inline payload from the sync change — flat fields (projectId/userId)
  // need to be normalized to the nested API shape (project: { id }) used downstream.
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
  return input?.taskId
    || input?.item?.taskId
    || input?.item?.id;
}

function buildTimeActivityPayload(
  task: TaskDto,
  externalCustomerId: string,
  externalEmployeeId: string,
  externalItemId?: string,
  hourlyRate?: number
): Record<string, unknown> {
  const start = parseDate(task.startDateTime);
  const end = parseDate(task.endDateTime);

  if (!start || !end) {
    throw new Error(`Task ${task.id} is missing start or end datetime.`);
  }

  const payload: Record<string, unknown> = {
    TxnDate: start.toISOString().slice(0, 10),
    StartTime: start.toISOString(),
    EndTime: end.toISOString(),
    TimeZone: 'UTC',
    Description: task.description ?? '',
    NameOf: 'Employee',
    BillableStatus: toQuickBooksBillableStatus(task.billable, task.billed),
    CustomerRef: {
      value: externalCustomerId
    },
    EmployeeRef: {
      value: externalEmployeeId
    }
  };

  if (externalItemId) {
    payload.ItemRef = { value: externalItemId };
  }
  if (hourlyRate !== undefined) {
    payload.HourlyRate = hourlyRate;
  }

  return payload;
}

// With rateSource 'timesheet-rate' the QuickBooks entry carries an explicit
// HourlyRate so invoice lines match Timesheet instead of the service item's
// sales price. salaryTotal is computed server-side as wall-hours × project
// salary × rate factor + wall-hours × rate extra (zeroed when not billable or
// when salary is hidden from the installation user), so salaryTotal divided by
// wall-hours reconstructs the effective hourly rate.
async function resolveHourlyRateForPush(
  task: TaskDto,
  context: IntegrationContext<QuickBooksConfig>
): Promise<number | undefined> {
  const rateSource = context.config?.rateSource ?? 'quickbooks-service';
  if (rateSource !== 'timesheet-rate' || !task.billable) {
    return undefined;
  }

  let hourlyRate = computeHourlyRate(task);
  if (hourlyRate === undefined && task.salaryTotal === undefined) {
    // Inline sync payloads carry no computed salary fields — fall back to the full task.
    try {
      const full = await context.data.getTask(task.id);
      if (full) {
        hourlyRate = computeHourlyRate(full);
      }
    } catch {
      // Leave HourlyRate unset; QuickBooks falls back to the service item price.
    }
  }
  return hourlyRate;
}

function computeHourlyRate(task: TaskDto): number | undefined {
  const salaryTotal = Number(task.salaryTotal);
  const duration = Number(task.duration);
  if (!Number.isFinite(salaryTotal) || salaryTotal <= 0 || !Number.isFinite(duration) || duration <= 0) {
    return undefined;
  }
  return Math.round((salaryTotal / (duration / 3600)) * 100) / 100;
}

// The Timesheet API datetime format is `yyyy-MM-dd'T'HH:mm:ssxxx`
// (e.g. 2021-03-19T18:00:00+00:00). Date.toISOString() emits milliseconds and a
// trailing 'Z', which the API rejects and then mis-repairs (it pads the hour to
// three digits). Emit seconds precision with an explicit +00:00 offset instead.
function toApiDateTime(date: Date): string {
  return `${date.toISOString().slice(0, 19)}+00:00`;
}

function buildTaskDateRange(activity: QuickBooksTimeActivity): { startDateTime: string; endDateTime: string } | null {
  const start = parseDate(activity.StartTime);
  const end = parseDate(activity.EndTime);

  if (start && end) {
    return {
      startDateTime: toApiDateTime(start),
      endDateTime: toApiDateTime(end)
    };
  }

  if (activity.TxnDate) {
    const day = parseDate(`${activity.TxnDate}T00:00:00Z`);
    if (!day) {
      return null;
    }

    const hours = Number(activity.Hours ?? 0);
    const minutes = Number(activity.Minutes ?? 0);
    const computedEnd = new Date(day.getTime() + ((hours * 60) + minutes) * 60_000);

    return {
      startDateTime: toApiDateTime(day),
      endDateTime: toApiDateTime(computedEnd)
    };
  }

  return null;
}

function parseDate(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// QuickBooks BillableStatus has only three values, so an unbillable-but-billed
// (billable=false, billed=true) state can't be represented round-trip — we
// downgrade it to NotBillable to keep `billable` authoritative on push.
function toQuickBooksBillableStatus(billable: boolean, billed: boolean): string {
  if (!billable) {
    return 'NotBillable';
  }
  return billed ? 'HasBeenBilled' : 'Billable';
}

function isBillable(status: string | undefined): boolean {
  return status === 'Billable' || status === 'HasBeenBilled';
}

function isBilled(status: string | undefined): boolean {
  return status === 'HasBeenBilled';
}

function getExternalUpdatedAt(activity: QuickBooksTimeActivity): number {
  const value = activity.MetaData?.LastUpdatedTime
    || activity.MetaData?.LastChangedInQB
    || activity.MetaData?.CreateTime;
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

function parseTimeActivityEvent(event: QuickBooksCloudEvent | undefined): EntityChange | null {
  const realmId = event?.intuitaccountid;
  const id = event?.intuitentityid;
  const type = event?.type;
  if (!realmId || !id || !type) {
    return null;
  }
  // CloudEvents type format: "qbo.<entity>.<action>.v1", e.g. "qbo.timeactivity.updated.v1".
  const segments = type.toLowerCase().split('.');
  const entity = segments[1];
  const action = segments[2];
  if (entity !== 'timeactivity' || !action) {
    return null;
  }
  return { id, operation: action, realmId };
}

function isDeleteOperation(operation: string): boolean {
  // CloudEvents actions are past tense; treat deleted and voided as hard removals.
  // Merge is rare on TimeActivity but the merged-from entity becomes inaccessible,
  // so we drop it locally as well.
  return operation === 'deleted' || operation === 'voided' || operation === 'merged';
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
  // Falling back to JSON.stringify will only match Intuit's signature if the
  // runtime serializes the parsed body identically to the request bytes — it
  // typically doesn't. Verifier mismatches will fail closed downstream.
  if (input?.body && typeof input.body === 'object') {
    try {
      return JSON.stringify(input.body);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseWebhookPayload(body: unknown, rawBody: string): QuickBooksWebhookPayload | null {
  if (Array.isArray(body)) {
    return body as QuickBooksWebhookPayload;
  }
  if (rawBody) {
    try {
      const parsed = JSON.parse(rawBody);
      return Array.isArray(parsed) ? (parsed as QuickBooksWebhookPayload) : null;
    } catch {
      return null;
    }
  }
  return null;
}

// Web Crypto is used so this plugin works in sandboxed runtimes (esbuild bundler
// without Node built-ins). Both Node 18+ and the plugin runtime expose
// `globalThis.crypto.subtle`.
async function verifyIntuitSignature(rawBody: string, signatureHeader: string, verifierToken: string): Promise<boolean> {
  // Intuit signs the raw request body with HMAC-SHA256 keyed on the webhook
  // verifier token, and sends the digest as standard base64 in `intuit-signature`.
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(verifierToken),
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
    // Fallback for environments where btoa isn't a global (older Node test runs).
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
