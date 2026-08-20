import { IntegrationContext, MappingRecord, TaskDto, ToDoDto } from '@timesheet/integration-sdk';
import { handleWebhook } from '../notion/src/handlers/handleWebhook';
import { runFullSync } from '../notion/src/handlers/runFullSync';
import { syncTaskToExternal } from '../notion/src/handlers/syncTaskToExternal';
import { syncTodoToExternal } from '../notion/src/handlers/syncTodoToExternal';
import { resetSharedClient } from '../notion/src/lib/taskSync';

// Schemas served by GET /v1/databases/{id}: a todo database with a grouped
// status property and a time-log database with number + relation properties.
const TODO_DB_SCHEMA = {
  id: 'db-1',
  properties: {
    Name: { id: 'ttl', name: 'Name', type: 'title' },
    Status: {
      id: 'st',
      name: 'Status',
      type: 'status',
      status: {
        options: [
          { id: 'o1', name: 'Not started' },
          { id: 'o2', name: 'In progress' },
          { id: 'o3', name: 'Done' }
        ],
        groups: [
          { id: 'g1', name: 'To-do', option_ids: ['o1'] },
          { id: 'g2', name: 'In progress', option_ids: ['o2'] },
          { id: 'g3', name: 'Complete', option_ids: ['o3'] }
        ]
      }
    },
    Due: { id: 'du', name: 'Due', type: 'date' }
  }
};

const TIMELOG_DB_SCHEMA = {
  id: 'tl-1',
  properties: {
    Entry: { id: 'ttl', name: 'Entry', type: 'title' },
    When: { id: 'wh', name: 'When', type: 'date' },
    Hours: { id: 'hr', name: 'Hours', type: 'number' },
    Task: { id: 'rl', name: 'Task', type: 'relation' }
  }
};

const createFetchResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: 'OK',
  headers: { forEach: () => {}, get: () => null },
  json: async () => body,
  text: async () => JSON.stringify(body)
});

const installFetch = (options?: { queryResults?: Record<string, unknown[]> }): jest.Mock => {
  const fetchMock = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (requestUrl.includes('/v1/databases/') && requestUrl.includes('/query')) {
      const databaseId = requestUrl.split('/v1/databases/')[1].split('/')[0];
      return createFetchResponse({
        results: options?.queryResults?.[databaseId] ?? [],
        has_more: false,
        next_cursor: null
      });
    }
    if (requestUrl.includes('/v1/databases/db-1')) {
      return createFetchResponse(TODO_DB_SCHEMA);
    }
    if (requestUrl.includes('/v1/databases/tl-1')) {
      return createFetchResponse(TIMELOG_DB_SCHEMA);
    }
    if (requestUrl.endsWith('/v1/pages') && method === 'POST') {
      return createFetchResponse({
        id: 'page-new',
        last_edited_time: '2026-03-01T10:00:00.000Z',
        parent: { type: 'database_id', database_id: 'db-1' }
      });
    }
    if (requestUrl.includes('/v1/pages/') && method === 'PATCH') {
      const pageId = requestUrl.split('/v1/pages/')[1];
      return createFetchResponse({ id: pageId, last_edited_time: '2026-03-01T10:00:00.000Z' });
    }
    return createFetchResponse({});
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
};

const baseTodo: ToDoDto = {
  id: 'todo-1',
  user: 'user-1',
  name: 'Write specs',
  status: 0,
  estimatedHours: 0,
  estimatedMinutes: 0,
  duration: 0,
  durationBreak: 0,
  salaryTotal: '0',
  salaryBreak: '0',
  expenses: '0',
  expensesPaid: '0',
  mileage: '0',
  deleted: false,
  lastUpdate: 1500,
  created: 1000,
  dueDate: '2026-03-01',
  project: {
    id: 'project-1',
    user: 'user-1',
    title: 'Client Work',
    archived: false,
    deleted: false,
    lastUpdate: 1000,
    created: 1000,
    duration: 0,
    durationBreak: 0,
    salaryTotal: '0',
    salaryBreak: '0',
    expenses: '0',
    expensesPaid: '0',
    mileage: '0'
  }
};

const baseTask: TaskDto = {
  id: 'task-1',
  user: 'user-1',
  running: false,
  paid: false,
  billed: false,
  billable: true,
  duration: 3600,
  durationBreak: 600,
  salaryTotal: '0',
  salaryBreak: '0',
  expensesTotal: '0',
  expensesPaid: '0',
  mileage: '0',
  deleted: false,
  lastUpdate: 1500,
  created: 1000,
  description: 'Consulting',
  startDateTime: '2026-02-20T10:00:00.000Z',
  endDateTime: '2026-02-20T11:00:00.000Z',
  todo: {
    id: 'todo-1',
    user: 'user-1',
    name: 'Write specs',
    status: 0,
    estimatedHours: 0,
    estimatedMinutes: 0,
    duration: 0,
    durationBreak: 0,
    salaryTotal: '0',
    salaryBreak: '0',
    expenses: '0',
    expensesPaid: '0',
    mileage: '0',
    deleted: false,
    lastUpdate: 1000,
    created: 1000
  }
};

const mappingByEntity = (map: Record<string, MappingRecord | null>) =>
  jest.fn(async (input: { entity: string }) => map[input.entity] ?? null);

const baseLogger = () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() });
const baseCredentials = () => ({
  getAccessToken: jest.fn().mockResolvedValue('token'),
  refreshToken: jest.fn().mockResolvedValue('token-2'),
  getConnectionInfo: jest.fn().mockResolvedValue({ connected: true, provider: 'notion', accountId: 'ws-1' })
});
const baseState = () => ({ get: jest.fn().mockResolvedValue(null), set: jest.fn(), delete: jest.fn() });

const readCreatePageBody = (fetchMock: jest.Mock): { parent: { database_id: string }; properties: Record<string, unknown> } => {
  const call = fetchMock.mock.calls.find(
    ([reqUrl, init]) => String(reqUrl).endsWith('/v1/pages') && (init?.method ?? 'GET') === 'POST'
  );
  return JSON.parse(String((call as [unknown, RequestInit])[1].body));
};

describe('notion plugin', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    resetSharedClient();
  });

  it('creates a Notion page for a todo using discovered properties', async () => {
    const upsert = jest.fn();
    const fetchMock = installFetch();

    const context = {
      userId: 'user-1',
      installationId: 'installation-1',
      config: {},
      data: { getTodo: jest.fn().mockResolvedValue(baseTodo) },
      credentials: baseCredentials(),
      mappings: {
        get: mappingByEntity({
          project: { localId: 'project-1', externalId: 'db-1', syncStatus: 'SYNCED' },
          todo: null
        }),
        findByExternal: jest.fn(),
        list: jest.fn(),
        upsert,
        delete: jest.fn()
      },
      state: baseState(),
      logger: baseLogger()
    } as unknown as IntegrationContext;

    const result = await syncTodoToExternal({ entityId: 'todo-1' }, context);

    expect(result.status).toBe('synced');
    const body = readCreatePageBody(fetchMock);
    expect(body.parent.database_id).toBe('db-1');
    expect(body.properties).toEqual({
      Name: { title: [{ type: 'text', text: { content: 'Write specs' } }] },
      Status: { status: { name: 'Not started' } },
      Due: { date: { start: '2026-03-01' } }
    });

    // Discovered properties are cached in state for the next run, but only for a
    // while: properties added after setup have to be picked up eventually.
    expect(context.state.set).toHaveBeenCalledWith(
      'notion:db-props:db-1',
      expect.objectContaining({ titleName: 'Name', statusName: 'Status', dateName: 'Due', doneOption: 'Done' }),
      expect.objectContaining({ ttlSeconds: expect.any(Number) })
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        system: 'notion',
        entity: 'todo',
        localId: 'todo-1',
        externalId: 'page-new',
        metadata: expect.objectContaining({
          databaseId: 'db-1',
          localProjectId: 'project-1',
          timesheetUpdatedAt: '1500',
          lastEditedTime: '2026-03-01T10:00:00.000Z'
        })
      })
    );
  });

  it('skips echoing a todo change that was just imported from Notion', async () => {
    const fetchMock = installFetch();
    const upsert = jest.fn();

    const context = {
      userId: 'user-1',
      installationId: 'installation-1',
      config: {},
      data: { getTodo: jest.fn().mockResolvedValue(baseTodo) },
      credentials: baseCredentials(),
      mappings: {
        get: mappingByEntity({
          project: { localId: 'project-1', externalId: 'db-1', syncStatus: 'SYNCED' },
          todo: {
            localId: 'todo-1',
            externalId: 'page-x',
            syncStatus: 'SYNCED',
            metadata: { timesheetUpdatedAt: String(baseTodo.lastUpdate + 500) }
          }
        }),
        findByExternal: jest.fn(),
        list: jest.fn(),
        upsert,
        delete: jest.fn()
      },
      state: baseState(),
      logger: baseLogger()
    } as unknown as IntegrationContext;

    const result = await syncTodoToExternal({ entityId: 'todo-1' }, context);

    expect(result.status).toBe('skipped');
    expect(result.details).toEqual(expect.objectContaining({ reason: 'already-synced-todo-change' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('archives the Notion page when the todo is deleted', async () => {
    const fetchMock = installFetch();
    const del = jest.fn();

    const context = {
      userId: 'user-1',
      installationId: 'installation-1',
      config: {},
      data: { getTodo: jest.fn() },
      credentials: baseCredentials(),
      mappings: {
        get: mappingByEntity({
          project: { localId: 'project-1', externalId: 'db-1', syncStatus: 'SYNCED' },
          todo: { localId: 'todo-1', externalId: 'page-x', syncStatus: 'SYNCED' }
        }),
        findByExternal: jest.fn(),
        list: jest.fn(),
        upsert: jest.fn(),
        delete: del
      },
      state: baseState(),
      logger: baseLogger()
    } as unknown as IntegrationContext;

    const result = await syncTodoToExternal(
      { entityId: 'todo-1', item: { todoId: 'todo-1', name: 'Write specs', deleted: true } },
      context
    );

    expect(result.status).toBe('deleted');
    const archiveCall = fetchMock.mock.calls.find(
      ([reqUrl, init]) => String(reqUrl).includes('/v1/pages/page-x') && (init?.method ?? 'GET') === 'PATCH'
    );
    expect(archiveCall).toBeDefined();
    expect(JSON.parse(String((archiveCall as [unknown, RequestInit])[1].body))).toEqual({ archived: true });
    expect(del).toHaveBeenCalledWith({ system: 'notion', entity: 'todo', localId: 'todo-1' });
  });

  it('creates a time-log row with hours, date range and todo relation', async () => {
    const upsert = jest.fn();
    const fetchMock = installFetch();

    const context = {
      userId: 'user-1',
      installationId: 'installation-1',
      config: { timeLogDatabaseId: 'tl-1' },
      data: { getTask: jest.fn().mockResolvedValue(baseTask) },
      credentials: baseCredentials(),
      mappings: {
        get: mappingByEntity({
          task: null,
          todo: {
            localId: 'todo-1',
            externalId: 'page-todo-1',
            syncStatus: 'SYNCED',
            metadata: { localProjectId: 'project-1' }
          }
        }),
        findByExternal: jest.fn(),
        list: jest.fn(),
        upsert,
        delete: jest.fn()
      },
      state: baseState(),
      logger: baseLogger()
    } as unknown as IntegrationContext;

    const result = await syncTaskToExternal({ taskId: 'task-1' }, context);

    expect(result.status).toBe('synced');
    const body = readCreatePageBody(fetchMock);
    expect(body.parent.database_id).toBe('tl-1');
    expect(body.properties).toEqual({
      Entry: { title: [{ type: 'text', text: { content: 'Consulting' } }] },
      When: { date: { start: '2026-02-20T10:00:00.000Z', end: '2026-02-20T11:00:00.000Z' } },
      // 3600s tracked minus a 600s break = 3000s = 0.83h.
      Hours: { number: 0.83 },
      Task: { relation: [{ id: 'page-todo-1' }] }
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: 'task',
        localId: 'task-1',
        externalId: 'page-new'
      })
    );
  });

  it('skips time entries when no time-log database is configured', async () => {
    const fetchMock = installFetch();
    const context = {
      userId: 'user-1',
      installationId: 'installation-1',
      config: {},
      data: { getTask: jest.fn().mockResolvedValue(baseTask) },
      credentials: baseCredentials(),
      mappings: { get: jest.fn(), findByExternal: jest.fn(), list: jest.fn(), upsert: jest.fn(), delete: jest.fn() },
      state: baseState(),
      logger: baseLogger()
    } as unknown as IntegrationContext;

    const result = await syncTaskToExternal({ taskId: 'task-1' }, context);

    expect(result.status).toBe('skipped');
    expect(result.details).toEqual(expect.objectContaining({ reason: 'time-log-database-not-configured' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('imports Notion pages into Timesheet todos on full sync', async () => {
    const createTodo = jest.fn().mockResolvedValue({ id: 'todo-created', lastUpdate: 1_771_600_000_000 });
    const upsert = jest.fn();
    installFetch({
      queryResults: {
        'db-1': [
          {
            id: 'page-1',
            last_edited_time: '2026-03-01T10:00:00.000Z',
            parent: { type: 'database_id', database_id: 'db-1' },
            properties: {
              Name: { type: 'title', title: [{ plain_text: 'From Notion' }] },
              Status: { type: 'status', status: { id: 'o3', name: 'Done' } },
              Due: { type: 'date', date: { start: '2026-03-05' } }
            }
          }
        ]
      }
    });

    const context = {
      userId: 'user-1',
      installationId: 'installation-1',
      config: {},
      data: { createTodo, getTodo: jest.fn(), updateTodo: jest.fn(), deleteTodo: jest.fn() },
      credentials: baseCredentials(),
      mappings: {
        list: jest.fn(async (input: { entity: string }) =>
          input.entity === 'project'
            ? [{ localId: 'project-1', externalId: 'db-1', syncStatus: 'SYNCED' }]
            : []
        ),
        findByExternal: jest.fn().mockResolvedValue(null),
        get: jest.fn(),
        upsert,
        delete: jest.fn()
      },
      state: baseState(),
      logger: baseLogger()
    } as unknown as IntegrationContext;

    const result = await runFullSync(undefined, context);

    expect(result.status).toBe('completed');
    expect(result.syncedCount).toBe(1);
    expect(createTodo).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        name: 'From Notion',
        status: 1,
        dueDate: '2026-03-05'
      })
    );
    // Import lock acquired before creating the todo.
    expect(context.state.set).toHaveBeenCalledWith(
      'import:todo:page-1',
      expect.any(Number),
      { ttlSeconds: 3600, ifAbsent: true }
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: 'todo',
        externalId: 'page-1',
        metadata: expect.objectContaining({ lastEditedTime: '2026-03-01T10:00:00.000Z' })
      })
    );
  });

  it('skips inbound pages whose last_edited_time was already recorded', async () => {
    const updateTodo = jest.fn();
    installFetch({
      queryResults: {
        'db-1': [
          {
            id: 'page-1',
            last_edited_time: '2026-03-01T10:00:00.000Z',
            parent: { type: 'database_id', database_id: 'db-1' },
            properties: {
              Name: { type: 'title', title: [{ plain_text: 'Echo' }] }
            }
          }
        ]
      }
    });

    const context = {
      userId: 'user-1',
      installationId: 'installation-1',
      config: {},
      data: { createTodo: jest.fn(), getTodo: jest.fn(), updateTodo, deleteTodo: jest.fn() },
      credentials: baseCredentials(),
      mappings: {
        list: jest.fn(async (input: { entity: string }) =>
          input.entity === 'project'
            ? [{ localId: 'project-1', externalId: 'db-1', syncStatus: 'SYNCED' }]
            : []
        ),
        findByExternal: jest.fn().mockResolvedValue({
          localId: 'todo-1',
          externalId: 'page-1',
          syncStatus: 'SYNCED',
          metadata: { lastEditedTime: '2026-03-01T10:00:00.000Z' }
        }),
        get: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn()
      },
      state: baseState(),
      logger: baseLogger()
    } as unknown as IntegrationContext;

    const result = await runFullSync(undefined, context);

    expect(result.status).toBe('completed');
    expect(result.syncedCount).toBe(0);
    expect(updateTodo).not.toHaveBeenCalled();
  });

  it('stores the verification token on the webhook handshake', async () => {
    installFetch();
    const context = {
      userId: 'user-1',
      installationId: 'installation-1',
      config: {},
      data: {},
      credentials: baseCredentials(),
      mappings: { get: jest.fn(), findByExternal: jest.fn(), list: jest.fn(), upsert: jest.fn(), delete: jest.fn() },
      state: baseState(),
      logger: baseLogger()
    } as unknown as IntegrationContext;

    const result = await handleWebhook({ body: { verification_token: 'vt-1' } }, context);

    expect(result.status).toBe('handshake');
    expect(context.state.set).toHaveBeenCalledWith('notion:webhook-secret', 'vt-1');
  });

  it('deletes the local todo on a page.deleted webhook event', async () => {
    installFetch();
    const deleteTodo = jest.fn();
    const mappingsDelete = jest.fn();

    const context = {
      userId: 'user-1',
      installationId: 'installation-1',
      config: {},
      data: { deleteTodo, deleteTask: jest.fn() },
      credentials: baseCredentials(),
      mappings: {
        findByExternal: jest.fn(async (input: { entity: string }) =>
          input.entity === 'todo'
            ? { localId: 'todo-9', externalId: 'page-1', syncStatus: 'SYNCED' }
            : null
        ),
        get: jest.fn(),
        list: jest.fn(),
        upsert: jest.fn(),
        delete: mappingsDelete
      },
      state: baseState(),
      logger: baseLogger()
    } as unknown as IntegrationContext;

    const result = await handleWebhook(
      {
        verified: true,
        body: { type: 'page.deleted', entity: { id: 'page-1', type: 'page' } }
      },
      context
    );

    expect(result.status).toBe('completed');
    expect(result.syncedCount).toBe(1);
    expect(deleteTodo).toHaveBeenCalledWith('todo-9');
    expect(mappingsDelete).toHaveBeenCalledWith({ system: 'notion', entity: 'todo', localId: 'todo-9' });
  });
});
