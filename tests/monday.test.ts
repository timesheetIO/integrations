import { IntegrationContext, MappingRecord } from '@timesheet/integration-sdk';

import { runFullSync } from '../monday/src/handlers/runFullSync';
import { resetSharedClient, syncTodoToMonday } from '../monday/src/lib/taskSync';

const projectMapping: MappingRecord = {
  localId: 'project-1',
  externalId: 'board-1',
  syncStatus: 'SYNCED',
  metadata: { localProjectId: 'project-1' }
};

/**
 * A Timesheet list of `total` records as the API pages it: `limit` per page (500 without
 * one), and page 1 again for any page when everything fits on one page. Records are
 * deleted, so the backfill skips them without calling monday.com.
 */
const timesheetList = (total: number) => {
  let calls = 0;
  return jest.fn(async (params: { page?: number; limit?: number }) => {
    // A loop that never ends would spin on resolved promises, which no test timeout stops.
    if (++calls > 10) throw new Error('paged past the last page');
    const limit = params.limit && params.limit > 0 ? params.limit : 500;
    const page = total <= limit ? 1 : params.page ?? 1;
    const start = (page - 1) * limit;
    const length = Math.max(0, Math.min(limit, total - start));
    return {
      items: Array.from({ length }, (_, i) => ({ id: `record-${start + i}`, deleted: true })),
      params: { count: total, limit }
    };
  });
};

const buildContext = (data: Record<string, unknown>) =>
  ({
    userId: 'user-1',
    installationId: 'installation-1',
    config: { syncDirection: 'timesheet-to-monday' },
    data,
    credentials: {
      getAccessToken: jest.fn().mockResolvedValue('token'),
      refreshToken: jest.fn().mockResolvedValue('token-2'),
      getConnectionInfo: jest.fn().mockResolvedValue({ connected: true, provider: 'monday', accountId: 'a' })
    },
    mappings: {
      get: jest.fn(async () => null),
      findByExternal: jest.fn(async () => null),
      list: jest.fn(async (input: { entity: string }) => (input.entity === 'project' ? [projectMapping] : [])),
      upsert: jest.fn(),
      delete: jest.fn()
    },
    state: { get: jest.fn(async () => null), set: jest.fn(), delete: jest.fn() },
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  } as unknown as IntegrationContext);

beforeEach(() => {
  jest.restoreAllMocks();
  resetSharedClient();
});

describe('monday Sync Now pages the local todos and time entries', () => {
  it('asks for 100 per page and stops at the last page', async () => {
    // 150 records: before, `count` set no page size, the API answered all 150 on its one
    // 500 page, and page 2 was page 1 again, so the backfill never ended.
    const listTodos = timesheetList(150);
    const listTasks = timesheetList(150);

    await runFullSync(undefined, buildContext({ listTodos, listTasks }));

    for (const list of [listTodos, listTasks]) {
      expect(list.mock.calls.map(([params]) => params)).toEqual([
        expect.objectContaining({ projectId: 'project-1', page: 1, limit: 100 }),
        expect.objectContaining({ projectId: 'project-1', page: 2, limit: 100 })
      ]);
      expect(list.mock.calls[0][0]).not.toHaveProperty('count');
    }
  });
});

describe('monday closed todos', () => {
  const todoMapping: MappingRecord = { localId: 'todo-1', externalId: 'item-1', syncStatus: 'SYNCED', metadata: {} };
  const closedTodo = {
    id: 'todo-1',
    name: 'Write the brief',
    status: 1,
    dueDate: '2026-11-20T01:00:00+01:00',
    lastUpdate: 2,
    project: { id: 'project-1' }
  };

  /**
   * monday.com answering one board: its columns, and every column write recorded.
   * `missing` are column ids monday refuses, the way it does for a deleted column.
   */
  const mondayBoard = (columns: unknown[], missing: string[] = []) => {
    const writes: Array<Record<string, unknown>> = [];
    let columnLists = 0;
    (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      let answer: unknown;
      if (body.query.includes('columns { id title type }')) {
        columnLists++;
        answer = { data: { boards: [{ columns }] } };
      } else if (body.query.includes('create_column')) {
        answer = { data: { create_column: { id: `new-${body.variables.title}`, type: body.variables.columnType } } };
      } else {
        const values = JSON.parse(String(body.variables.columnValues)) as Record<string, unknown>;
        const refused = Object.keys(values).find((id) => missing.includes(id));
        if (refused) {
          answer = {
            errors: [
              {
                message: "This column ID doesn't exist for the board",
                extensions: { code: 'InvalidColumnIdException', error_data: { column_id: refused } }
              }
            ]
          };
        } else {
          writes.push(values);
          answer = { data: { change_multiple_column_values: { id: 'item-1', name: 'Write the brief' } } };
        }
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(answer) };
    });
    return { writes, columnLists: () => columnLists };
  };

  const context = (cachedColumns: unknown = null) => {
    const ctx = buildContext({}) as unknown as {
      mappings: { get: jest.Mock };
      state: { get: jest.Mock; delete: jest.Mock };
    };
    ctx.mappings.get.mockImplementation(async (input: { entity: string }) =>
      input.entity === 'project' ? projectMapping : input.entity === 'todo' ? todoMapping : null
    );
    let cache = cachedColumns;
    ctx.state.get.mockImplementation(async () => cache);
    ctx.state.delete.mockImplementation(async () => {
      cache = null;
    });
    return ctx as unknown as IntegrationContext;
  };

  const dateColumns = [
    { id: 'date_start', title: 'Timesheet Start', type: 'date' },
    { id: 'date_end', title: 'Timesheet End', type: 'date' },
    { id: 'person', title: 'Owner', type: 'people' }
  ];

  it('marks the board status column Done, whatever its id', async () => {
    const board = mondayBoard([...dateColumns, { id: 'project_status', title: 'Status', type: 'status' }]);

    const result = await syncTodoToMonday({ todoId: 'todo-1', item: closedTodo } as never, context());

    expect(result.status).toBe('synced');
    expect(board.writes[0]).toMatchObject({ project_status: { label: 'Done' } });
    expect(board.writes[0]).not.toHaveProperty('status');
  });

  it('sends no status to a board without a status column', async () => {
    // Before, every closed todo sent `status` and monday refused the whole write, every night.
    const board = mondayBoard(dateColumns, ['status']);

    const result = await syncTodoToMonday({ todoId: 'todo-1', item: closedTodo } as never, context());

    expect(result.status).toBe('synced');
    expect(board.writes[0]).toMatchObject({ date_end: expect.anything() });
  });

  it('looks the columns up again when a cached column was deleted on the board', async () => {
    // The cache still holds the Timesheet End column the user deleted on monday.com.
    const board = mondayBoard(
      [{ id: 'date_start', title: 'Timesheet Start', type: 'date' }, { id: 'person', title: 'Owner', type: 'people' }],
      ['date_end']
    );
    const ctx = context({ dateStartId: 'date_start', dateEndId: 'date_end', personId: 'person' });

    const result = await syncTodoToMonday({ todoId: 'todo-1', item: closedTodo } as never, ctx);

    expect(result.status).toBe('synced');
    expect(board.columnLists()).toBe(1);
    expect(board.writes[0]).toMatchObject({ 'new-Timesheet End': expect.anything() });
    expect(board.writes[0]).not.toHaveProperty('date_end');
  });
});
