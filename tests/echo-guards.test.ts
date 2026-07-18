import { IntegrationContext, MappingRecord } from '@timesheet/integration-sdk';
import { syncTodoToAsana, resetSharedClient as resetAsanaClient } from '../asana/src/lib/taskSync';
import { syncTodoToMonday, resetSharedClient as resetMondayClient } from '../monday/src/lib/taskSync';
import { syncTodoToClickUp, resetSharedClient as resetClickUpClient } from '../clickup/src/lib/taskSync';

/**
 * Verifies the echo guards are actually wired into the asana/monday/clickup
 * outbound paths: a local change that is not newer than the mapping's
 * `timesheetUpdatedAt` stamp is the event fired by the plugin's own inbound
 * write and must be skipped without touching the external API; anything newer
 * syncs out and re-stamps the mapping. Guard semantics themselves are covered
 * by the SDK unit tests (sync-guards.test.ts).
 */

const TODO_LAST_UPDATE = 1500;

const baseTodo = {
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
  lastUpdate: TODO_LAST_UPDATE,
  created: 1000,
  project: { id: 'project-1' }
};

interface HarnessOptions {
  projectExternalId: string;
  todoMappingMetadata: Record<string, unknown>;
}

const createContext = (options: HarnessOptions) => {
  const upsert = jest.fn();
  const projectMapping: MappingRecord = {
    localId: 'project-1',
    externalId: options.projectExternalId,
    syncStatus: 'SYNCED'
  };
  const todoMapping: MappingRecord = {
    localId: 'todo-1',
    externalId: 'ext-todo-1',
    syncStatus: 'SYNCED',
    metadata: options.todoMappingMetadata as MappingRecord['metadata']
  };

  const context = {
    userId: 'user-1',
    installationId: 'installation-1',
    config: {},
    data: {
      getTodo: jest.fn().mockResolvedValue(baseTodo),
      getTask: jest.fn(),
      createTask: jest.fn(),
      updateTask: jest.fn(),
      createTodo: jest.fn(),
      updateTodo: jest.fn()
    },
    credentials: {
      getAccessToken: jest.fn().mockResolvedValue('token'),
      refreshToken: jest.fn().mockResolvedValue('token-2')
    },
    mappings: {
      get: jest.fn().mockImplementation(async (input: { entity: string }) => {
        if (input.entity === 'project') return projectMapping;
        if (input.entity === 'todo') return todoMapping;
        return null;
      }),
      findByExternal: jest.fn().mockResolvedValue(null),
      list: jest.fn().mockResolvedValue([]),
      upsert,
      delete: jest.fn()
    },
    state: {
      // Serves monday's board-columns cache; guards never read state.
      get: jest.fn().mockResolvedValue({ dateStartId: 'date_start', dateEndId: 'date_end' }),
      set: jest.fn(),
      delete: jest.fn()
    },
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  } as unknown as IntegrationContext;

  return { context, upsert };
};

const createFetchResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: { forEach: () => {} },
  json: async () => body,
  text: async () => JSON.stringify(body)
});

const installFetchMock = () => {
  const fetchMock = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = String(url);
    if (requestUrl.includes('app.asana.com/api/1.0/tasks/ext-todo-1')) {
      return createFetchResponse({
        data: { gid: 'ext-todo-1', name: 'Write specs', modified_at: '2026-03-01T10:00:00.000Z' }
      });
    }
    if (requestUrl.includes('api.monday.com/v2')) {
      const query = typeof init?.body === 'string' ? init.body : '';
      if (query.includes('change_multiple_column_values')) {
        return createFetchResponse({
          data: {
            change_multiple_column_values: {
              id: 'ext-todo-1',
              name: 'Write specs',
              updated_at: '2026-03-01T10:00:00Z',
              board: { id: 'board-1' }
            }
          }
        });
      }
      return createFetchResponse({ data: {} });
    }
    if (requestUrl.includes('api.clickup.com')) {
      return createFetchResponse({
        id: 'ext-todo-1',
        name: 'Write specs',
        date_updated: '1750000000000',
        url: 'https://app.clickup.com/t/ext-todo-1'
      });
    }
    return createFetchResponse({});
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
};

type OutboundSync = (input: unknown, context: IntegrationContext) => Promise<{
  status: string;
  details?: Record<string, unknown>;
}>;

const plugins: Array<{
  slug: string;
  sync: OutboundSync;
  reset: () => void;
  input: Record<string, string>;
  projectExternalId: string;
  externalStampKey: string;
}> = [
  {
    slug: 'asana',
    sync: syncTodoToAsana as OutboundSync,
    reset: resetAsanaClient,
    input: { entityId: 'todo-1' },
    projectExternalId: 'ext-project-1',
    externalStampKey: 'modifiedAt'
  },
  {
    slug: 'monday',
    sync: syncTodoToMonday as OutboundSync,
    reset: resetMondayClient,
    input: { todoId: 'todo-1' },
    projectExternalId: 'board-1',
    externalStampKey: 'updatedAt'
  },
  {
    slug: 'clickup',
    sync: syncTodoToClickUp as OutboundSync,
    reset: resetClickUpClient,
    input: { todoId: 'todo-1' },
    projectExternalId: 'team-1:list-1',
    externalStampKey: 'dateUpdated'
  }
];

describe('outbound echo guards (asana/monday/clickup)', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    resetAsanaClient();
    resetMondayClient();
    resetClickUpClient();
  });

  for (const plugin of plugins) {
    it(`${plugin.slug}: skips the echo of its own inbound write without calling the external API`, async () => {
      const fetchMock = installFetchMock();
      const { context, upsert } = createContext({
        projectExternalId: plugin.projectExternalId,
        // Stamp is newer than the todo's lastUpdate → this change is our echo.
        todoMappingMetadata: { timesheetUpdatedAt: String(TODO_LAST_UPDATE + 500) }
      });

      const result = await plugin.sync(plugin.input, context);

      expect(result.status).toBe('skipped');
      expect(result.details).toEqual(expect.objectContaining({ reason: 'already-synced-todo-change' }));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();
    });

    it(`${plugin.slug}: syncs a genuinely newer change and re-stamps the mapping`, async () => {
      const fetchMock = installFetchMock();
      const { context, upsert } = createContext({
        projectExternalId: plugin.projectExternalId,
        // Stamp is older than the todo's lastUpdate → a real user change.
        todoMappingMetadata: { timesheetUpdatedAt: String(TODO_LAST_UPDATE - 500) }
      });

      const result = await plugin.sync(plugin.input, context);

      expect(result.status).toBe('synced');
      expect(fetchMock).toHaveBeenCalled();
      expect(upsert).toHaveBeenCalledTimes(1);
      const upserted = upsert.mock.calls[0][0];
      expect(upserted.metadata.timesheetUpdatedAt).toBe(String(TODO_LAST_UPDATE));
      expect(upserted.metadata[plugin.externalStampKey]).toBeTruthy();
    });
  }
});
