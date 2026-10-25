import { IntegrationContext, MappingRecord } from '@timesheet/integration-sdk';

import { runFullSync } from '../monday/src/handlers/runFullSync';
import { resetSharedClient } from '../monday/src/lib/taskSync';

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
