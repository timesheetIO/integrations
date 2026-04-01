import {
  IntegrationContext,
  MappingRecord,
  TaskCreateInput,
  TaskDto,
  TaskUpdateInput
} from '@timesheet/integration-sdk';
import { QuickBooksClient } from './quickbooksClient';
import {
  QuickBooksConfig,
  QuickBooksTimeActivity,
  QuickBooksWebhookPayload,
  SyncInput
} from './types';

const SYSTEM = 'quickbooks';
const PROJECT_ENTITY = 'project';
const USER_ENTITY = 'user';
const TASK_ENTITY = 'task';

export interface QuickBooksSyncResult {
  system: string;
  status: string;
  syncedCount: number;
  details?: Record<string, unknown>;
}

export async function syncTaskToQuickBooks(
  input: SyncInput,
  context: IntegrationContext<QuickBooksConfig>
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

  const projectId = task.project?.id;
  if (!projectId) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'missing-project', taskId } };
  }

  const projectMapping = await context.mappings.get({
    system: SYSTEM,
    entity: PROJECT_ENTITY,
    localId: projectId
  });
  if (!projectMapping?.externalId) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'missing-project-mapping', projectId } };
  }

  const localUserId = task.user ?? task.member?.uid;
  if (!localUserId) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'missing-user', taskId } };
  }

  const userMapping = await context.mappings.get({
    system: SYSTEM,
    entity: USER_ENTITY,
    localId: localUserId
  });
  if (!userMapping?.externalId) {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'missing-user-mapping', userId: localUserId } };
  }

  const client = await createClient(context, input?.realmId);
  const taskMapping = await context.mappings.get({
    system: SYSTEM,
    entity: TASK_ENTITY,
    localId: task.id
  });

  if (task.deleted) {
    if (taskMapping?.externalId) {
      const existing = await client.getTimeActivity(taskMapping.externalId);
      if (existing?.Id && existing.SyncToken) {
        await client.deleteTimeActivity(existing.Id, existing.SyncToken);
      }
      await context.mappings.delete({
        system: SYSTEM,
        entity: TASK_ENTITY,
        localId: task.id
      });
      return { system: SYSTEM, status: 'deleted', syncedCount: 1 };
    }
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'already-deleted' } };
  }

  let payload: Record<string, unknown>;
  try {
    payload = buildTimeActivityPayload(task, projectMapping.externalId, userMapping.externalId);
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

  await context.mappings.upsert({
    system: SYSTEM,
    entity: TASK_ENTITY,
    localId: task.id,
    externalId: external.Id,
    externalLabel: task.description ?? task.id,
    metadata: {
      customerId: projectMapping.externalId,
      employeeId: userMapping.externalId,
      syncToken: external.SyncToken ?? '',
      txnDate: external.TxnDate ?? ''
    },
    syncStatus: 'SYNCED'
  });

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

  let syncedCount = 0;

  if (allowInbound) {
    const client = await createClient(context);
    const activities = await client.listTimeActivities();

    const projectByExternalId = new Map(projectMappings.map((mapping) => [mapping.externalId, mapping.localId]));
    const userByExternalId = new Map(userMappings.map((mapping) => [mapping.externalId, mapping.localId]));

    for (const activity of activities) {
      const synced = await syncSingleExternalActivity(
        activity,
        context,
        projectByExternalId,
        userByExternalId
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
    details: { syncDirection }
  };
}

export async function handleQuickBooksWebhook(
  input: SyncInput,
  context: IntegrationContext<QuickBooksConfig>
): Promise<QuickBooksSyncResult> {
  const syncDirection = context.config?.syncDirection ?? 'bidirectional';
  if (syncDirection === 'timesheet-to-qb' || syncDirection === 'timesheet-to-external') {
    return { system: SYSTEM, status: 'skipped', syncedCount: 0, details: { reason: 'sync-direction-mismatch' } };
  }

  const payload = asWebhookPayload(input?.body);
  const entities = payload?.eventNotifications ?? [];

  const ids = new Set<string>();
  for (const notification of entities) {
    const dataEntities = notification?.dataChangeEvent?.entities ?? [];
    for (const entity of dataEntities) {
      if (!entity?.id || !entity?.name) {
        continue;
      }
      if (entity.name.toLowerCase() === 'timeactivity') {
        ids.add(entity.id);
      }
    }
  }

  if (ids.size === 0 && input?.externalTaskId) {
    ids.add(input.externalTaskId);
  }

  if (ids.size === 0) {
    return {
      system: SYSTEM,
      status: 'ignored',
      syncedCount: 0,
      details: { reason: 'no-time-activity-ids' }
    };
  }

  const projectMappings = await context.mappings.list({ system: SYSTEM, entity: PROJECT_ENTITY });
  const userMappings = await context.mappings.list({ system: SYSTEM, entity: USER_ENTITY });
  const projectByExternalId = new Map(projectMappings.map((mapping) => [mapping.externalId, mapping.localId]));
  const userByExternalId = new Map(userMappings.map((mapping) => [mapping.externalId, mapping.localId]));

  const client = await createClient(context, input?.realmId);

  let syncedCount = 0;
  for (const id of ids) {
    const activity = await client.getTimeActivity(id);
    if (!activity) {
      continue;
    }

    const synced = await syncSingleExternalActivity(
      activity,
      context,
      projectByExternalId,
      userByExternalId
    );

    if (synced) {
      syncedCount += 1;
    }
  }

  return {
    system: SYSTEM,
    status: 'completed',
    syncedCount,
    details: { entityCount: ids.size }
  };
}

function asWebhookPayload(body: unknown): QuickBooksWebhookPayload | null {
  if (!body || typeof body !== 'object') {
    return null;
  }
  return body as QuickBooksWebhookPayload;
}

async function syncSingleExternalActivity(
  activity: QuickBooksTimeActivity,
  context: IntegrationContext<QuickBooksConfig>,
  projectByExternalId: Map<string, string>,
  userByExternalId: Map<string, string>
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
      billed: isBilled(activity.BillableStatus)
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
    billed: isBilled(activity.BillableStatus)
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

async function createClient(
  context: IntegrationContext<QuickBooksConfig>,
  realmOverride?: string
): Promise<QuickBooksClient> {
  const connectionInfo = await context.credentials.getConnectionInfo(SYSTEM);
  const realmId = realmOverride
    || connectionInfo?.accountId;

  if (!realmId) {
    throw new Error('QuickBooks realmId/accountId missing. Complete OAuth first.');
  }

  return new QuickBooksClient({
    realmId,
    sandboxMode: context.config?.sandboxMode === true,
    getAccessToken: () => context.credentials.getAccessToken(SYSTEM),
    refreshAccessToken: () => context.credentials.refreshToken(SYSTEM)
  });
}

async function loadTask(
  taskId: string,
  input: SyncInput,
  context: IntegrationContext<QuickBooksConfig>
): Promise<TaskDto | null> {
  try {
    return await context.data.getTask(taskId);
  } catch {
    if (input?.item && typeof input.item === 'object') {
      return input.item as TaskDto;
    }
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
  externalEmployeeId: string
): Record<string, unknown> {
  const start = parseDate(task.startDateTime);
  const end = parseDate(task.endDateTime);

  if (!start || !end) {
    throw new Error(`Task ${task.id} is missing start or end datetime.`);
  }

  return {
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
}

function buildTaskDateRange(activity: QuickBooksTimeActivity): { startDateTime: string; endDateTime: string } | null {
  const start = parseDate(activity.StartTime);
  const end = parseDate(activity.EndTime);

  if (start && end) {
    return {
      startDateTime: start.toISOString(),
      endDateTime: end.toISOString()
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
      startDateTime: day.toISOString(),
      endDateTime: computedEnd.toISOString()
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

function toQuickBooksBillableStatus(billable: boolean, billed: boolean): string {
  if (billed) {
    return 'HasBeenBilled';
  }
  return billable ? 'Billable' : 'NotBillable';
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
