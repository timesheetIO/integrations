import { IntegrationContext, MappingRecord, TaskDto } from '@timesheet/integration-sdk';
import { runFullSync } from '../freshbooks/src/handlers/runFullSync';
import { syncTaskToExternal } from '../freshbooks/src/handlers/syncTaskToExternal';
import { resetSharedClient } from '../freshbooks/src/lib/taskSync';

const ME_RESPONSE = {
  response: {
    id: 999,
    business_memberships: [
      { id: 111, role: 'owner', business: { id: 111, account_id: 'acc-1', active: true } }
    ]
  }
};

const createFetchResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: 'OK',
  headers: { forEach: () => {} },
  json: async () => body,
  text: async () => JSON.stringify(body)
});

// Routes the FreshBooks REST surface used by the tests. `listEntries` seeds the
// time_entries list endpoint (inbound full sync).
const installFetch = (options?: { listEntries?: unknown[] }): jest.Mock => {
  const fetchMock = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (requestUrl.includes('/auth/api/v1/users/me')) {
      return createFetchResponse(ME_RESPONSE);
    }
    if (requestUrl.includes('/time_entries')) {
      if (method === 'POST') {
        return createFetchResponse({ time_entry: { id: 5095 } });
      }
      if (method === 'PUT') {
        return createFetchResponse({ time_entry: { id: 5095 } });
      }
      if (method === 'DELETE') {
        return createFetchResponse(null, 204);
      }
      // GET list
      return createFetchResponse({ time_entries: options?.listEntries ?? [], meta: { pages: 1 } });
    }
    return createFetchResponse({});
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
};

const baseTask: TaskDto = {
  id: 'task-1',
  user: 'user-1',
  running: false,
  paid: false,
  billed: false,
  billable: true,
  duration: 3600,
  durationBreak: 0,
  salaryTotal: '0',
  salaryBreak: '0',
  expensesTotal: '0',
  expensesPaid: '0',
  mileage: '0',
  deleted: false,
  lastUpdate: 1_700_000_000_000,
  created: 1_700_000_000_000,
  description: 'Consulting',
  startDateTime: '2026-02-20T10:00:00.000Z',
  endDateTime: '2026-02-20T11:00:00.000Z',
  project: {
    id: 'project-1',
    user: 'user-1',
    title: 'Client Work',
    archived: false,
    deleted: false,
    lastUpdate: 1_700_000_000_000,
    created: 1_700_000_000_000,
    duration: 0,
    durationBreak: 0,
    salaryTotal: '0',
    salaryBreak: '0',
    expenses: '0',
    expensesPaid: '0',
    mileage: '0'
  }
};

const mappingByEntity = (map: Record<string, MappingRecord | null>) =>
  jest.fn(async (input: { entity: string }) => map[input.entity] ?? null);

const listByEntity = (map: Record<string, MappingRecord[]>) =>
  jest.fn(async (input: { entity: string }) => map[input.entity] ?? []);

const baseLogger = () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() });
const baseCredentials = () => ({
  getAccessToken: jest.fn().mockResolvedValue('token'),
  refreshToken: jest.fn().mockResolvedValue('token-2'),
  getConnectionInfo: jest.fn().mockResolvedValue({ connected: true, provider: 'freshbooks', accountId: 'acc-1' })
});

describe('freshbooks plugin', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    resetSharedClient();
  });

  it('creates a FreshBooks time entry and upserts the task mapping', async () => {
    const upsert = jest.fn();
    const fetchMock = installFetch();

    const context = {
      userId: 'user-1',
      installationId: 'installation-1',
      config: {},
      data: { getTask: jest.fn().mockResolvedValue(baseTask) },
      credentials: baseCredentials(),
      mappings: {
        get: mappingByEntity({
          project: { localId: 'project-1', externalId: '101', syncStatus: 'SYNCED', metadata: { clientId: '301' } },
          user: { localId: 'user-1', externalId: '201', syncStatus: 'SYNCED' },
          task: null
        }),
        findByExternal: jest.fn(),
        list: jest.fn(),
        upsert,
        delete: jest.fn()
      },
      state: { get: jest.fn(), set: jest.fn(), delete: jest.fn() },
      logger: baseLogger()
    } as unknown as IntegrationContext;

    const result = await syncTaskToExternal({ taskId: 'task-1' }, context);

    expect(result.status).toBe('synced');
    expect(result.syncedCount).toBe(1);

    const postCall = fetchMock.mock.calls.find(
      ([reqUrl, init]) => String(reqUrl).includes('/time_entries') && (init?.method ?? 'GET') === 'POST'
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse(String((postCall as [unknown, RequestInit])[1].body)) as {
      time_entry: Record<string, unknown>;
    };
    expect(body.time_entry).toEqual(
      expect.objectContaining({
        is_logged: true,
        duration: 3600,
        started_at: '2026-02-20T10:00:00Z',
        note: 'Consulting',
        project_id: 101,
        identity_id: 201,
        client_id: 301,
        billable: true
      })
    );

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        system: 'freshbooks',
        entity: 'task',
        localId: 'task-1',
        externalId: '5095',
        metadata: expect.objectContaining({
          projectId: '101',
          identityId: '201',
          timesheetUpdatedAt: String(baseTask.lastUpdate)
        })
      })
    );
  });

  it('subtracts break time from the reported duration', async () => {
    const fetchMock = installFetch();
    const task: TaskDto = { ...baseTask, duration: 3600, durationBreak: 600 };

    const context = {
      userId: 'user-1',
      installationId: 'installation-1',
      config: {},
      data: { getTask: jest.fn().mockResolvedValue(task) },
      credentials: baseCredentials(),
      mappings: {
        get: mappingByEntity({
          project: { localId: 'project-1', externalId: '101', syncStatus: 'SYNCED', metadata: { clientId: '301' } },
          user: { localId: 'user-1', externalId: '201', syncStatus: 'SYNCED' },
          task: null
        }),
        findByExternal: jest.fn(),
        list: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn()
      },
      state: { get: jest.fn(), set: jest.fn(), delete: jest.fn() },
      logger: baseLogger()
    } as unknown as IntegrationContext;

    await syncTaskToExternal({ taskId: 'task-1' }, context);

    const postCall = fetchMock.mock.calls.find(
      ([reqUrl, init]) => String(reqUrl).includes('/time_entries') && (init?.method ?? 'GET') === 'POST'
    );
    const body = JSON.parse(String((postCall as [unknown, RequestInit])[1].body)) as {
      time_entry: Record<string, unknown>;
    };
    // 3600s tracked minus a 600s break = 3000s billable.
    expect(body.time_entry.duration).toBe(3000);
  });

  it('skips echoing a task change that was just imported from FreshBooks', async () => {
    const upsert = jest.fn();
    const fetchMock = installFetch();

    const context = {
      userId: 'user-1',
      installationId: 'installation-1',
      config: {},
      data: { getTask: jest.fn().mockResolvedValue(baseTask) },
      credentials: baseCredentials(),
      mappings: {
        get: mappingByEntity({
          project: { localId: 'project-1', externalId: '101', syncStatus: 'SYNCED', metadata: { clientId: '301' } },
          user: { localId: 'user-1', externalId: '201', syncStatus: 'SYNCED' },
          task: {
            localId: 'task-1',
            externalId: '5095',
            syncStatus: 'SYNCED',
            metadata: { timesheetUpdatedAt: String(baseTask.lastUpdate) }
          }
        }),
        findByExternal: jest.fn(),
        list: jest.fn(),
        upsert,
        delete: jest.fn()
      },
      state: { get: jest.fn(), set: jest.fn(), delete: jest.fn() },
      logger: baseLogger()
    } as unknown as IntegrationContext;

    const result = await syncTaskToExternal({ taskId: 'task-1' }, context);

    expect(result.status).toBe('skipped');
    expect(result.details).toEqual(expect.objectContaining({ reason: 'already-synced-task-change' }));
    expect(upsert).not.toHaveBeenCalled();
    // Only identifier resolution (/users/me) may be called; no write occurs.
    const writeCall = fetchMock.mock.calls.find(([, init]) => (init?.method ?? 'GET') !== 'GET');
    expect(writeCall).toBeUndefined();
  });

  it('deletes the FreshBooks time entry when the task is deleted', async () => {
    const del = jest.fn();
    const fetchMock = installFetch();

    const context = {
      userId: 'user-1',
      installationId: 'installation-1',
      config: {},
      data: { getTask: jest.fn().mockResolvedValue({ ...baseTask, deleted: true }) },
      credentials: baseCredentials(),
      mappings: {
        get: mappingByEntity({
          project: { localId: 'project-1', externalId: '101', syncStatus: 'SYNCED', metadata: { clientId: '301' } },
          user: { localId: 'user-1', externalId: '201', syncStatus: 'SYNCED' },
          task: { localId: 'task-1', externalId: '5095', syncStatus: 'SYNCED' }
        }),
        findByExternal: jest.fn(),
        list: jest.fn(),
        upsert: jest.fn(),
        delete: del
      },
      state: { get: jest.fn(), set: jest.fn(), delete: jest.fn() },
      logger: baseLogger()
    } as unknown as IntegrationContext;

    const result = await syncTaskToExternal({ taskId: 'task-1', item: { id: 'task-1', deleted: true } }, context);

    expect(result.status).toBe('deleted');
    const deleteCall = fetchMock.mock.calls.find(
      ([reqUrl, init]) => String(reqUrl).includes('/time_entries/5095') && (init?.method ?? 'GET') === 'DELETE'
    );
    expect(deleteCall).toBeDefined();
    expect(del).toHaveBeenCalledWith({ system: 'freshbooks', entity: 'task', localId: 'task-1' });
  });

  it('imports FreshBooks time entries into Timesheet tasks on full sync', async () => {
    const createTask = jest.fn().mockResolvedValue({ id: 'task-created', lastUpdate: 1_771_600_000_000 });
    const upsert = jest.fn();
    installFetch({
      listEntries: [
        {
          id: 5095,
          project_id: 101,
          identity_id: 201,
          service_id: 401,
          started_at: '2026-02-20T10:00:00Z',
          duration: 3600,
          note: 'Imported from FreshBooks',
          billable: true,
          billed: false,
          created_at: '2026-02-20T09:00:00Z'
        }
      ]
    });

    const context = {
      userId: 'user-1',
      installationId: 'installation-1',
      config: {},
      data: { createTask, getTask: jest.fn(), updateTask: jest.fn(), deleteTask: jest.fn() },
      credentials: baseCredentials(),
      mappings: {
        list: listByEntity({
          project: [{ localId: 'project-1', externalId: '101', syncStatus: 'SYNCED' }],
          user: [{ localId: 'user-1', externalId: '201', syncStatus: 'SYNCED' }],
          rate: [{ localId: 'rate-1', externalId: '401', syncStatus: 'SYNCED' }]
        }),
        findByExternal: jest.fn().mockResolvedValue(null),
        get: jest.fn(),
        upsert,
        delete: jest.fn()
      },
      state: { get: jest.fn().mockResolvedValue(null), set: jest.fn(), delete: jest.fn() },
      logger: baseLogger()
    } as unknown as IntegrationContext;

    const result = await runFullSync(undefined, context);

    expect(result.status).toBe('completed');
    expect(result.syncedCount).toBe(1);
    // Must use the Timesheet API datetime format (offset, no milliseconds, no 'Z').
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        userId: 'user-1',
        startDateTime: '2026-02-20T10:00:00+00:00',
        endDateTime: '2026-02-20T11:00:00+00:00',
        description: 'Imported from FreshBooks',
        billable: true,
        rateId: 'rate-1'
      })
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: 'task',
        externalId: '5095',
        metadata: expect.objectContaining({ timesheetUpdatedAt: '1771600000000' })
      })
    );
    // Import lock acquired before creating the task.
    expect(context.state.set).toHaveBeenCalledWith(
      expect.stringMatching(/^freshbooks:time-entry-import:/),
      expect.any(Number),
      { ttlSeconds: 3600, ifAbsent: true }
    );
  });

  it('skips inbound entries whose content already matches the local task', async () => {
    const updateTask = jest.fn();
    installFetch({
      listEntries: [
        {
          id: 5095,
          project_id: 101,
          identity_id: 201,
          service_id: 401,
          started_at: '2026-02-20T10:00:00Z',
          duration: 3600,
          note: 'Consulting',
          billable: true,
          created_at: '2026-02-20T09:00:00Z'
        }
      ]
    });

    const existing: TaskDto = {
      ...baseTask,
      startDateTime: '2026-02-20T10:00:00+00:00',
      endDateTime: '2026-02-20T11:00:00+00:00',
      description: 'Consulting',
      billable: true,
      rate: {
        id: 'rate-1',
        user: 'user-1',
        title: 'Std',
        factor: '1',
        extra: '0',
        enabled: true,
        archived: false,
        deleted: false,
        lastUpdate: 1_700_000_000_000,
        created: 1_700_000_000_000
      }
    };

    const context = {
      userId: 'user-1',
      installationId: 'installation-1',
      config: {},
      data: { createTask: jest.fn(), getTask: jest.fn().mockResolvedValue(existing), updateTask, deleteTask: jest.fn() },
      credentials: baseCredentials(),
      mappings: {
        list: listByEntity({
          project: [{ localId: 'project-1', externalId: '101', syncStatus: 'SYNCED' }],
          user: [{ localId: 'user-1', externalId: '201', syncStatus: 'SYNCED' }],
          rate: [{ localId: 'rate-1', externalId: '401', syncStatus: 'SYNCED' }]
        }),
        findByExternal: jest.fn().mockResolvedValue({ localId: 'task-1', externalId: '5095', syncStatus: 'SYNCED' }),
        get: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn()
      },
      state: { get: jest.fn().mockResolvedValue(null), set: jest.fn(), delete: jest.fn() },
      logger: baseLogger()
    } as unknown as IntegrationContext;

    const result = await runFullSync(undefined, context);

    expect(result.status).toBe('completed');
    expect(result.syncedCount).toBe(0);
    expect(updateTask).not.toHaveBeenCalled();
  });
});
