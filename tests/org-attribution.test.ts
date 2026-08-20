import { IntegrationContext, MappingRecord } from '@timesheet/integration-sdk';

import { handleWebhook as asanaWebhook } from '../asana/src/handlers/handleWebhook';
import { resetSharedClient as resetAsana } from '../asana/src/lib/taskSync';
import { runFullSync as clickupFullSync } from '../clickup/src/handlers/runFullSync';
import { resetSharedClient as resetClickUp } from '../clickup/src/lib/taskSync';
import { listExternalProjects as mondayListProjects } from '../monday/src/handlers/listExternalProjects';
import { runFullSync as mondayFullSync } from '../monday/src/handlers/runFullSync';
import { syncTaskToExternal as mondaySyncTask } from '../monday/src/handlers/syncTaskToExternal';
import { resetSharedClient as resetMonday } from '../monday/src/lib/taskSync';
import { runFullSync as notionFullSync } from '../notion/src/handlers/runFullSync';
import { resetSharedClient as resetNotion } from '../notion/src/lib/taskSync';

/**
 * Cross-plugin contract for organization installs: inbound work runs as the
 * installing admin, so a plugin that imports time without an explicit userId
 * books every member's hours on that admin. Attribution is create-only, so a
 * wrong owner here can never be corrected.
 */

const createFetchResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: { get: () => null, forEach: () => {} },
  json: async () => body,
  text: async () => JSON.stringify(body)
});

const installFetch = (route: (url: string, init?: RequestInit) => unknown | undefined): jest.Mock => {
  const fetchMock = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const routed = route(String(url), init);
    return createFetchResponse(routed === undefined ? {} : routed);
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
};

/** Installation that mapped user-1 onto external member 9001, and nobody else. */
const mappings = (overrides: {
  list?: (entity: string) => MappingRecord[];
  findByExternal?: (entity: string, externalId: string) => MappingRecord | null;
  get?: (entity: string) => MappingRecord | null;
}) => ({
  get: jest.fn(async (input: { entity: string }) => (overrides.get ? overrides.get(input.entity) : null)),
  findByExternal: jest.fn(async (input: { entity: string; externalId: string }) =>
    overrides.findByExternal ? overrides.findByExternal(input.entity, input.externalId) : null
  ),
  list: jest.fn(async (input: { entity: string }) => {
    if (input.entity === 'user') {
      return [{ localId: 'user-1', externalId: '9001', syncStatus: 'SYNCED' }] as MappingRecord[];
    }
    return overrides.list ? overrides.list(input.entity) : [];
  }),
  upsert: jest.fn(),
  delete: jest.fn()
});

const buildContext = (
  config: Record<string, unknown>,
  mappingClient: ReturnType<typeof mappings>,
  data: Record<string, unknown>,
  state: Record<string, unknown> = {}
) =>
  ({
    userId: 'admin-1',
    installationId: 'installation-1',
    organizationId: 'org-1',
    config: { syncDirection: 'bidirectional', ...config },
    data: {
      getTask: jest.fn(),
      getTodo: jest.fn(),
      createTodo: jest.fn().mockResolvedValue({ id: 'todo-9', lastUpdate: 1 }),
      updateTodo: jest.fn().mockResolvedValue({ id: 'todo-9', lastUpdate: 1 }),
      ...data
    },
    credentials: {
      getAccessToken: jest.fn().mockResolvedValue('token'),
      refreshToken: jest.fn().mockResolvedValue('token-2'),
      getConnectionInfo: jest.fn().mockResolvedValue({ connected: true, provider: 'p', accountId: 'a' })
    },
    mappings: mappingClient,
    state: {
      get: jest.fn(async (key: string) => (key in state ? state[key] : null)),
      set: jest.fn(),
      delete: jest.fn()
    },
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  } as unknown as IntegrationContext);

/** Minimal stopped time entry with both ends, which monday needs for its date columns. */
const baseTaskShape = {
  id: 'task-1',
  user: 'user-1',
  running: false,
  deleted: false,
  lastUpdate: 1_700_000_000_000,
  description: 'Consulting',
  startDateTime: '2026-02-20T10:00:00.000Z',
  endDateTime: '2026-02-20T11:00:00.000Z',
  project: { id: 'project-1' }
};

const projectMapping: MappingRecord = {
  localId: 'project-1',
  externalId: 'external-project-1',
  syncStatus: 'SYNCED',
  metadata: { localProjectId: 'project-1' }
};

const todoMapping: MappingRecord = {
  localId: 'todo-1',
  externalId: 'external-todo-1',
  syncStatus: 'SYNCED',
  metadata: { localProjectId: 'project-1' }
};

beforeEach(() => {
  jest.restoreAllMocks();
  resetAsana();
  resetClickUp();
  resetMonday();
  resetNotion();
});

describe('asana attributes imported time', () => {
  const webhookBody = {
    events: [{ action: 'changed', resource: { gid: 'entry-1', resource_type: 'time_tracking_entry' } }]
  };

  const routeEntry = (createdByGid: string) => (url: string) => {
    if (url.includes('/time_tracking_entries/entry-1')) {
      return {
        data: {
          gid: 'entry-1',
          duration_minutes: 60,
          entered_on: '2026-02-20',
          created_by: { gid: createdByGid },
          task: { gid: 'external-todo-1' }
        }
      };
    }
    return { data: [] };
  };

  it('books the entry on the mapped member', async () => {
    installFetch(routeEntry('9001'));
    const createTask = jest.fn().mockResolvedValue({ id: 'task-9', user: 'user-1', lastUpdate: 1 });

    await asanaWebhook(
      { body: webhookBody },
      buildContext(
        {},
        mappings({
          list: (entity) => (entity === 'project' ? [projectMapping] : []),
          findByExternal: (entity) => (entity === 'todo' ? todoMapping : null)
        }),
        { createTask }
      )
    );

    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }));
  });

  it('skips an entry logged by an unmapped Asana user', async () => {
    installFetch(routeEntry('7777'));
    const createTask = jest.fn();

    await asanaWebhook(
      { body: webhookBody },
      buildContext(
        {},
        mappings({
          list: (entity) => (entity === 'project' ? [projectMapping] : []),
          findByExternal: (entity) => (entity === 'todo' ? todoMapping : null)
        }),
        { createTask }
      )
    );

    expect(createTask).not.toHaveBeenCalled();
  });
});

describe('notion attributes imported time', () => {
  const database = {
    id: 'time-log-db',
    properties: {
      Name: { id: 'title', name: 'Name', type: 'title' },
      Date: { id: 'date', name: 'Date', type: 'date' },
      Todo: { id: 'rel', name: 'Todo', type: 'relation' }
    }
  };

  const page = (createdById: string) => ({
    id: 'page-1',
    created_by: { object: 'user', id: createdById },
    last_edited_time: '2026-02-20T12:00:00.000Z',
    parent: { type: 'database_id', database_id: 'time-log-db' },
    properties: {
      Name: { type: 'title', title: [{ plain_text: 'Consulting' }] },
      Date: { type: 'date', date: { start: '2026-02-20T10:00:00.000Z', end: '2026-02-20T11:00:00.000Z' } },
      Todo: { type: 'relation', relation: [{ id: 'external-todo-1' }] }
    }
  });

  const routePages = (createdById: string) => (url: string) => {
    if (url.includes('/v1/databases/time-log-db/query')) {
      return { results: [page(createdById)], has_more: false, next_cursor: null };
    }
    if (url.includes('/v1/databases/')) {
      return database;
    }
    return { results: [], has_more: false, next_cursor: null };
  };

  const context = (createTask: jest.Mock) =>
    buildContext(
      { timeLogDatabaseId: 'time-log-db' },
      mappings({
        // The full sync walks mapped databases first and only then the
        // time-log database, so it needs at least one project mapping.
        list: (entity) => (entity === 'project' ? [projectMapping] : []),
        findByExternal: (entity) => (entity === 'todo' ? todoMapping : null)
      }),
      { createTask }
    );

  it('books the time log on the mapped member', async () => {
    installFetch(routePages('9001'));
    const createTask = jest.fn().mockResolvedValue({ id: 'task-9', user: 'user-1', lastUpdate: 1 });

    await notionFullSync(undefined, context(createTask));

    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }));
  });

  it('skips a time log created by an unmapped Notion user', async () => {
    installFetch(routePages('7777'));
    const createTask = jest.fn();

    await notionFullSync(undefined, context(createTask));

    expect(createTask).not.toHaveBeenCalled();
  });
});

describe('monday attributes imported time', () => {
  const subitem = (creatorId: string) => ({
    id: 'sub-1',
    name: 'Consulting',
    state: 'active',
    creator_id: creatorId,
    created_at: '2026-02-20T10:00:00.000Z',
    updated_at: '2026-02-20T12:00:00.000Z',
    board: { id: 'subboard-1' },
    parent_item: { id: 'external-todo-1', board: { id: 'external-project-1' } },
    column_values: [
      { id: 'start', type: 'date', text: '2026-02-20', value: '{"date":"2026-02-20","time":"10:00:00"}' },
      { id: 'end', type: 'date', text: '2026-02-20', value: '{"date":"2026-02-20","time":"11:00:00"}' }
    ]
  });

  const routeGraphql = (creatorId: string) => (_url: string, init?: RequestInit) => {
    const query = typeof init?.body === 'string' ? init.body : '';
    if (query.includes('items_page')) {
      return { data: { boards: [{ items_page: { cursor: null, items: [subitem(creatorId)] } }] } };
    }
    if (query.includes('columns')) {
      return {
        data: {
          boards: [{
            columns: [
              { id: 'start', title: 'Timesheet Start', type: 'date' },
              { id: 'end', title: 'Timesheet End', type: 'date' }
            ]
          }]
        }
      };
    }
    return { data: {} };
  };

  it('books the subitem on the mapped member', async () => {
    installFetch(routeGraphql('9001'));
    const createTask = jest.fn().mockResolvedValue({ id: 'task-9', user: 'user-1', lastUpdate: 1 });

    await mondayFullSync(
      undefined,
      buildContext(
        {},
        mappings({ list: (entity) => (entity === 'project' ? [projectMapping] : []) }),
        { createTask }
      )
    );

    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }));
  });

  it('skips a subitem created by an unmapped monday.com user', async () => {
    installFetch(routeGraphql('7777'));
    const createTask = jest.fn();

    await mondayFullSync(
      undefined,
      buildContext(
        {},
        mappings({ list: (entity) => (entity === 'project' ? [projectMapping] : []) }),
        { createTask }
      )
    );

    // Booking a colleague's monday.com time on the installing admin is the
    // failure this guard exists to prevent.
    expect(createTask).not.toHaveBeenCalled();
  });
});

describe('clickup carries assignees into imported todos', () => {
  const clickupTask = (assigneeIds: string[]) => ({
    id: 'cu-1',
    name: 'Spec work',
    date_updated: '1740000000000',
    status: { status: 'open', type: 'open' },
    list: { id: 'list-1' },
    assignees: assigneeIds.map((id) => ({ id }))
  });

  const routeTasks = (assigneeIds: string[]) => (url: string) => {
    if (url.includes('/list/list-1/task')) {
      return { tasks: [clickupTask(assigneeIds)], last_page: true };
    }
    if (url.includes('/team')) {
      return { teams: [{ id: 'team-1', name: 'Acme' }] };
    }
    return {};
  };

  const listMapping: MappingRecord = {
    localId: 'project-1',
    externalId: 'list-1',
    syncStatus: 'SYNCED'
  };

  it('assigns the mapped member on the local todo', async () => {
    installFetch(routeTasks(['9001']));
    const createTodo = jest.fn().mockResolvedValue({ id: 'todo-9', lastUpdate: 1 });

    await clickupFullSync(
      undefined,
      buildContext(
        {},
        mappings({ list: (entity) => (entity === 'project' ? [listMapping] : []) }),
        { createTodo }
      )
    );

    expect(createTodo).toHaveBeenCalledWith(expect.objectContaining({ assignedUsers: 'user-1' }));
  });

  it('leaves assignment alone when only unmapped people are assigned', async () => {
    installFetch(routeTasks(['7777']));
    const createTodo = jest.fn().mockResolvedValue({ id: 'todo-9', lastUpdate: 1 });

    await clickupFullSync(
      undefined,
      buildContext(
        {},
        mappings({ list: (entity) => (entity === 'project' ? [listMapping] : []) }),
        { createTodo }
      )
    );

    expect(createTodo).toHaveBeenCalledWith(expect.not.objectContaining({ assignedUsers: expect.anything() }));
  });
});

describe('monday board picker', () => {
  it('hides subitems boards, which reject create_item', async () => {
    installFetch((_url, init) => {
      const query = typeof init?.body === 'string' ? init.body : '';
      if (query.includes('boards(')) {
        return {
          data: {
            boards: [
              { id: '100', name: 'Client work', state: 'active', type: 'board' },
              { id: '101', name: 'Subitems of Client work', state: 'active', type: 'sub_items_board' }
            ]
          }
        };
      }
      return { data: {} };
    });

    const boards = await mondayListProjects(
      undefined,
      buildContext({}, mappings({}), {})
    );

    // Mapping a project to a subitems board makes every todo-less time entry fail
    // with "Can't create an item on subitems board".
    expect(boards.map((b) => b.id)).toEqual(['100']);
  });
});

describe('monday time entry visibility', () => {
  const parentBoardId = 'external-project-1';

  /**
   * A subitem created on a board without the Subitems column is real (it shows in
   * the activity log) but the board has nowhere to display it, and My Work only
   * lists a subitem when a person sits on the subitem itself.
   */
  const routeBoards = (options: { parentColumns: unknown[]; subitemColumns: unknown[] }) => {
    const created: string[] = [];
    const route = (_url: string, init?: RequestInit) => {
      const query = typeof init?.body === 'string' ? init.body : '';
      if (query.includes('create_column')) {
        const body = JSON.parse(query) as { variables?: { columnType?: string; boardId?: string } };
        created.push(`${body.variables?.boardId}:${body.variables?.columnType}`);
        return { data: { create_column: { id: 'new-col', title: 'x', type: body.variables?.columnType } } };
      }
      if (query.includes('create_subitem')) {
        return {
          data: {
            create_subitem: {
              id: 'sub-1',
              name: 'Consulting',
              board: { id: 'subboard-1' },
              parent_item: { id: 'external-todo-1', board: { id: parentBoardId } }
            }
          }
        };
      }
      if (query.includes('columns')) {
        const body = JSON.parse(query) as { variables?: { boardIds?: string[] } };
        const isParent = body.variables?.boardIds?.[0] === parentBoardId;
        return { data: { boards: [{ columns: isParent ? options.parentColumns : options.subitemColumns }] } };
      }
      return { data: { change_multiple_column_values: { id: 'sub-1', board: { id: 'subboard-1' } } } };
    };
    return { route, created };
  };

  // Cast once: the fixture is intentionally partial, the plugin reads a handful of fields.
  const taskWithTodo = { ...baseTaskShape, todo: { id: 'todo-1' } } as unknown as Record<string, unknown>;

  it('adds the Subitems column and a people column so entries are visible and reach My Work', async () => {
    const { route, created } = routeBoards({ parentColumns: [], subitemColumns: [] });
    installFetch(route);

    await mondaySyncTask(
      { taskId: 'task-1', item: taskWithTodo } as never,
      buildContext(
        {},
        mappings({
          list: (entity) => (entity === 'project' ? [projectMapping] : []),
          findByExternal: () => null,
          // The subitem path needs the todo's monday item as its parent.
          get: (entity) => (entity === 'todo' ? todoMapping : entity === 'project' ? projectMapping : null)
        }),
        { getTask: jest.fn().mockResolvedValue(taskWithTodo) }
      )
    );

    expect(created).toContain(`${parentBoardId}:subtasks`);
    expect(created.some((c) => c.endsWith(':people'))).toBe(true);
  });

  it('does not add columns that already exist', async () => {
    const { route, created } = routeBoards({
      parentColumns: [{ id: 'sub', title: 'Subitems', type: 'subtasks' }],
      subitemColumns: [
        { id: 'start', title: 'Timesheet Start', type: 'date' },
        { id: 'end', title: 'Timesheet End', type: 'date' },
        { id: 'p', title: 'Owner', type: 'people' }
      ]
    });
    installFetch(route);

    await mondaySyncTask(
      { taskId: 'task-1', item: taskWithTodo } as never,
      buildContext(
        {},
        mappings({
          list: (entity) => (entity === 'project' ? [projectMapping] : []),
          findByExternal: () => null,
          // The subitem path needs the todo's monday item as its parent.
          get: (entity) => (entity === 'todo' ? todoMapping : entity === 'project' ? projectMapping : null)
        }),
        { getTask: jest.fn().mockResolvedValue(taskWithTodo) }
      )
    );

    expect(created).toEqual([]);
  });
});
