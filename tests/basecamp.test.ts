import { IntegrationContext, MappingRecord, TaskDto, ToDoDto } from '@timesheet/integration-sdk';
import { handleWebhook } from '../basecamp/src/handlers/handleWebhook';
import { syncTaskToExternal } from '../basecamp/src/handlers/syncTaskToExternal';
import { syncTodoToExternal } from '../basecamp/src/handlers/syncTodoToExternal';
import { resetSharedClient } from '../basecamp/src/lib/taskSync';

const ACCOUNT_ID = '195539477';
const BUCKET_ID = '2085958505';

const createFetchResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: 'OK',
  headers: { get: () => null },
  json: async () => body,
  text: async () => JSON.stringify(body)
});

type FetchRoute = (url: string, init?: RequestInit) => unknown | undefined;

const installFetch = (route?: FetchRoute): jest.Mock => {
  const fetchMock = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = String(url);

    if (requestUrl.includes('launchpad.37signals.com/authorization.json')) {
      return createFetchResponse({ accounts: [{ id: Number(ACCOUNT_ID), product: 'bc3', name: 'Honcho Design' }] });
    }

    const routed = route?.(requestUrl, init);
    if (routed !== undefined) {
      return createFetchResponse(routed);
    }
    return createFetchResponse({});
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
};

const baseTodo: ToDoDto = {
  id: 'todo-1',
  user: 'user-1',
  name: 'Spec work',
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
  lastUpdate: 1_700_000_000_000,
  created: 1_700_000_000_000,
  project: { id: 'project-1' }
} as unknown as ToDoDto;

const baseTask: TaskDto = {
  id: 'task-1',
  user: 'user-1',
  running: false,
  paid: false,
  billed: false,
  billable: true,
  duration: 5400,
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
  endDateTime: '2026-02-20T11:30:00.000Z',
  todo: { id: 'todo-1' }
} as unknown as TaskDto;

const mappingByEntity = (map: Record<string, MappingRecord | null>) =>
  jest.fn(async (input: { entity: string }) => map[input.entity] ?? null);

interface ContextOverrides {
  config?: Record<string, unknown>;
  mappings?: Record<string, MappingRecord | null>;
  state?: Record<string, unknown>;
  findByExternal?: jest.Mock;
  list?: jest.Mock;
  data?: Record<string, unknown>;
}

const buildContext = (entity: ToDoDto | TaskDto, overrides: ContextOverrides = {}) => {
  const state = overrides.state ?? {};
  return {
    userId: 'user-1',
    installationId: 'installation-1',
    config: { syncDirection: 'bidirectional', ...(overrides.config ?? {}) },
    data: {
      getTodo: jest.fn().mockResolvedValue(entity),
      getTask: jest.fn().mockResolvedValue(entity),
      createTodo: jest.fn(),
      updateTodo: jest.fn(),
      deleteTodo: jest.fn(),
      ...(overrides.data ?? {})
    },
    credentials: {
      getAccessToken: jest.fn().mockResolvedValue('token'),
      refreshToken: jest.fn().mockResolvedValue('token-2')
    },
    mappings: {
      get: mappingByEntity(overrides.mappings ?? {}),
      findByExternal: overrides.findByExternal ?? jest.fn().mockResolvedValue(null),
      list: overrides.list ?? jest.fn().mockResolvedValue([]),
      upsert: jest.fn(),
      delete: jest.fn()
    },
    state: {
      get: jest.fn(async (key: string) => (key in state ? state[key] : null)),
      set: jest.fn(),
      delete: jest.fn()
    },
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  } as unknown as IntegrationContext;
};

const callsTo = (fetchMock: jest.Mock, fragment: string) =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes(fragment));

const bodyOf = (call: unknown[]): Record<string, unknown> =>
  JSON.parse(String((call as [unknown, RequestInit])[1].body)) as Record<string, unknown>;

beforeEach(() => {
  jest.restoreAllMocks();
  resetSharedClient();
});

describe('basecamp to-do writes', () => {
  it('resolves the account id from launchpad and creates in the project first to-do list', async () => {
    const fetchMock = installFetch((url) => {
      if (url.endsWith(`/projects/${BUCKET_ID}.json`)) {
        return { id: Number(BUCKET_ID), dock: [{ id: 111, name: 'todoset', enabled: true }] };
      }
      if (url.includes('/todosets/111/todolists.json')) {
        return [{ id: 222, title: 'To-dos' }];
      }
      if (url.includes('/todolists/222/todos.json')) {
        return { id: 333, content: 'Spec work', updated_at: '2026-02-20T10:00:00.000Z' };
      }
      return undefined;
    });

    const result = await syncTodoToExternal(
      { entityId: 'todo-1' },
      buildContext(baseTodo, {
        mappings: { project: { localId: 'project-1', externalId: BUCKET_ID, syncStatus: 'SYNCED' }, todo: null }
      })
    );

    expect(result.status).toBe('synced');
    // Every API call is account-scoped under the resolved id.
    const apiCalls = callsTo(fetchMock, '3.basecampapi.com');
    expect(apiCalls.length).toBeGreaterThan(0);
    for (const [url] of apiCalls) {
      expect(String(url)).toContain(`3.basecampapi.com/${ACCOUNT_ID}/`);
    }
    expect(callsTo(fetchMock, '/todolists/222/todos.json')).toHaveLength(1);
  });

  it('sends the mandatory User-Agent on every request', async () => {
    const fetchMock = installFetch((url) =>
      url.endsWith(`/projects/${BUCKET_ID}.json`) ? { id: Number(BUCKET_ID), dock: [] } : undefined
    );

    await syncTodoToExternal(
      { entityId: 'todo-1' },
      buildContext(baseTodo, {
        mappings: { project: { localId: 'project-1', externalId: BUCKET_ID, syncStatus: 'SYNCED' }, todo: null }
      })
    );

    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (const call of fetchMock.mock.calls) {
      const init = (call as [unknown, RequestInit])[1];
      expect((init.headers as Record<string, string>)['User-Agent']).toBe('Timesheet (https://timesheet.io)');
    }
  });

  it('completes an existing to-do through the completion subresource, not the update payload', async () => {
    const fetchMock = installFetch((url, init) => {
      if (url.endsWith('/todos/333.json')) {
        return {
          id: 333,
          content: 'Spec work',
          completed: false,
          status: 'active',
          updated_at: '2026-02-20T10:00:00.000Z',
          assignees: [{ id: 901 }],
          completion_subscribers: [{ id: 902 }]
        };
      }
      if (url.endsWith('/todos/333/completion.json') && init?.method === 'POST') {
        return {};
      }
      return undefined;
    });

    const closedTodo = { ...baseTodo, status: 1 } as ToDoDto;
    const result = await syncTodoToExternal(
      { entityId: 'todo-1' },
      buildContext(closedTodo, {
        mappings: {
          project: { localId: 'project-1', externalId: BUCKET_ID, syncStatus: 'SYNCED' },
          todo: { localId: 'todo-1', externalId: '333', syncStatus: 'SYNCED' }
        }
      })
    );

    expect(result.status).toBe('synced');

    const completionCalls = callsTo(fetchMock, '/todos/333/completion.json');
    expect(completionCalls).toHaveLength(1);
    expect((completionCalls[0] as [unknown, RequestInit])[1].method).toBe('POST');

    // The update carries the existing assignees forward: Basecamp clears any
    // field left out of the payload.
    const updateCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith('/todos/333.json') && (init as RequestInit)?.method === 'PUT'
    );
    expect(updateCall).toBeDefined();
    const payload = bodyOf(updateCall as unknown[]);
    expect(payload.assignee_ids).toEqual([901]);
    expect(payload.completion_subscriber_ids).toEqual([902]);
    expect(payload.completed).toBeUndefined();
  });

  it('trashes the recording on delete because Basecamp has no hard delete', async () => {
    const fetchMock = installFetch();
    const deletedTodo = { ...baseTodo, deleted: true } as ToDoDto;

    const result = await syncTodoToExternal(
      { entityId: 'todo-1' },
      buildContext(deletedTodo, {
        mappings: {
          project: { localId: 'project-1', externalId: BUCKET_ID, syncStatus: 'SYNCED' },
          todo: { localId: 'todo-1', externalId: '333', syncStatus: 'SYNCED' }
        }
      })
    );

    expect(result.status).toBe('deleted');
    const trashCalls = callsTo(fetchMock, '/recordings/333/status/trashed.json');
    expect(trashCalls).toHaveLength(1);
    expect((trashCalls[0] as [unknown, RequestInit])[1].method).toBe('PUT');
  });
});

describe('basecamp timesheet entries', () => {
  const todoMapping: MappingRecord = {
    localId: 'todo-1',
    externalId: '333',
    syncStatus: 'SYNCED',
    metadata: { bucketId: BUCKET_ID }
  };

  it('writes decimal hours when the project has the Timesheets add-on', async () => {
    const fetchMock = installFetch((url) => {
      if (url.endsWith(`/projects/${BUCKET_ID}.json`)) {
        return { id: Number(BUCKET_ID), timesheet_enabled: true };
      }
      if (url.endsWith('/recordings/333/timesheet/entries.json')) {
        return { id: 444, hours: '1.5', date: '2026-02-20' };
      }
      return undefined;
    });

    const result = await syncTaskToExternal(
      { taskId: 'task-1' },
      buildContext(baseTask, { mappings: { task: null, todo: todoMapping } })
    );

    expect(result.status).toBe('synced');
    const createCall = callsTo(fetchMock, '/recordings/333/timesheet/entries.json')[0];
    const payload = bodyOf(createCall as unknown[]);
    // 5400s tracked = 1.5h, and the date comes from the task start.
    expect(payload.hours).toBe('1.50');
    expect(payload.date).toBe('2026-02-20');
  });

  it('subtracts break seconds before converting to hours', async () => {
    const fetchMock = installFetch((url) => {
      if (url.endsWith(`/projects/${BUCKET_ID}.json`)) {
        return { id: Number(BUCKET_ID), timesheet_enabled: true };
      }
      if (url.endsWith('/recordings/333/timesheet/entries.json')) {
        return { id: 444 };
      }
      return undefined;
    });

    const task = { ...baseTask, duration: 5400, durationBreak: 900 } as TaskDto;
    const result = await syncTaskToExternal(
      { taskId: 'task-1' },
      buildContext(task, { mappings: { task: null, todo: todoMapping } })
    );

    expect(result.status).toBe('synced');
    // (5400 - 900)s = 4500s = 1.25h.
    expect(bodyOf(callsTo(fetchMock, '/timesheet/entries.json')[0] as unknown[]).hours).toBe('1.25');
  });

  it('skips time sync when the project lacks the paid Timesheets add-on', async () => {
    const fetchMock = installFetch((url) =>
      url.endsWith(`/projects/${BUCKET_ID}.json`) ? { id: Number(BUCKET_ID), timesheet_enabled: false } : undefined
    );

    const result = await syncTaskToExternal(
      { taskId: 'task-1' },
      buildContext(baseTask, { mappings: { task: null, todo: todoMapping } })
    );

    expect(result.status).toBe('skipped');
    expect(result.details?.reason).toBe('timesheet-not-enabled');
    expect(callsTo(fetchMock, '/timesheet/entries.json')).toHaveLength(0);
  });

  it('skips time sync entirely when pushTimeEntries is off', async () => {
    const fetchMock = installFetch();

    const result = await syncTaskToExternal(
      { taskId: 'task-1' },
      buildContext(baseTask, {
        config: { pushTimeEntries: 'off' },
        mappings: { task: null, todo: todoMapping }
      })
    );

    expect(result.status).toBe('skipped');
    expect(result.details?.reason).toBe('time-push-disabled');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('basecamp webhooks', () => {
  const mappedProjects = jest.fn(async (input: { entity: string }) =>
    input.entity === 'project' ? [{ localId: 'project-1', externalId: BUCKET_ID, syncStatus: 'SYNCED' }] : []
  );

  it('ignores deliveries for a bucket that is not mapped', async () => {
    const fetchMock = installFetch();

    const result = await handleWebhook(
      {
        body: {
          kind: 'todo_created',
          recording: { id: 333, type: 'Todo', bucket: { id: 999, type: 'Project' } }
        }
      },
      buildContext(baseTodo, { list: mappedProjects as unknown as jest.Mock })
    );

    expect(result.status).toBe('ignored');
    expect(result.details?.reason).toBe('unmapped-bucket');
    // Nothing is fetched: an unmapped bucket is rejected before any API call.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refetches the to-do rather than trusting the unsigned payload', async () => {
    const createTodo = jest.fn().mockResolvedValue({ id: 'todo-new', lastUpdate: 1_700_000_100_000 });
    const fetchMock = installFetch((url) =>
      url.endsWith('/todos/333.json')
        ? {
            id: 333,
            status: 'active',
            content: 'Real title from the API',
            completed: false,
            updated_at: '2026-02-20T12:00:00.000Z',
            bucket: { id: Number(BUCKET_ID), type: 'Project' }
          }
        : undefined
    );

    const result = await handleWebhook(
      {
        body: {
          kind: 'todo_created',
          // A spoofed title in the payload must never reach the local todo.
          recording: { id: 333, type: 'Todo', bucket: { id: Number(BUCKET_ID) }, content: 'Spoofed title' }
        }
      },
      buildContext(baseTodo, { list: mappedProjects as unknown as jest.Mock, data: { createTodo } })
    );

    expect(result.status).toBe('completed');
    expect(callsTo(fetchMock, '/todos/333.json')).toHaveLength(1);
    expect(createTodo).toHaveBeenCalledWith(expect.objectContaining({ name: 'Real title from the API' }));
  });

  it('deletes the local todo when the recording is no longer active', async () => {
    const deleteTodo = jest.fn();
    installFetch((url) =>
      url.endsWith('/todos/333.json')
        ? { id: 333, status: 'trashed', content: 'Spec work', bucket: { id: Number(BUCKET_ID) } }
        : undefined
    );

    const result = await handleWebhook(
      { body: { kind: 'todo_trashed', recording: { id: 333, type: 'Todo', bucket: { id: Number(BUCKET_ID) } } } },
      buildContext(baseTodo, {
        list: mappedProjects as unknown as jest.Mock,
        findByExternal: jest.fn().mockResolvedValue({ localId: 'todo-1', externalId: '333', syncStatus: 'SYNCED' }),
        data: { deleteTodo }
      })
    );

    expect(result.status).toBe('completed');
    expect(result.details?.action).toBe('deleted');
    expect(deleteTodo).toHaveBeenCalledWith('todo-1');
  });

  it('ignores non-todo recording types', async () => {
    const fetchMock = installFetch();

    const result = await handleWebhook(
      { body: { kind: 'message_created', recording: { id: 500, type: 'Message', bucket: { id: Number(BUCKET_ID) } } } },
      buildContext(baseTodo, { list: mappedProjects as unknown as jest.Mock })
    );

    expect(result.status).toBe('ignored');
    expect(result.details?.reason).toBe('unhandled-type');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
