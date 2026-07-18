import { IntegrationContext, MappingRecord, TaskDto } from '@timesheet/integration-sdk';
import { syncTaskToExternal } from '../asana/src/handlers/syncTaskToExternal';
import { resetSharedClient } from '../asana/src/lib/taskSync';

const createFetchResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: { forEach: () => {} },
  json: async () => body,
  text: async () => JSON.stringify(body)
});

// Captures the Asana time-tracking-entry create so tests can assert the payload.
const installFetch = (): jest.Mock => {
  const fetchMock = jest.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes('/time_tracking_entries')) {
      return createFetchResponse({ data: { gid: 'entry-1' } });
    }
    return createFetchResponse({ data: {} });
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
  todo: {
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
    created: 1_700_000_000_000
  }
};

const mappingByEntity = (map: Record<string, MappingRecord | null>) =>
  jest.fn(async (input: { entity: string }) => map[input.entity] ?? null);

const buildContext = (task: TaskDto) =>
  ({
    userId: 'user-1',
    installationId: 'installation-1',
    config: { syncDirection: 'bidirectional' },
    data: { getTask: jest.fn().mockResolvedValue(task) },
    credentials: {
      getAccessToken: jest.fn().mockResolvedValue('token'),
      refreshToken: jest.fn().mockResolvedValue('token-2')
    },
    mappings: {
      get: mappingByEntity({
        task: null,
        todo: { localId: 'todo-1', externalId: 'asana-task-1', syncStatus: 'SYNCED' }
      }),
      findByExternal: jest.fn(),
      list: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn()
    },
    state: { get: jest.fn(), set: jest.fn(), delete: jest.fn() },
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  } as unknown as IntegrationContext);

const readEntryPayload = (fetchMock: jest.Mock): Record<string, unknown> => {
  const call = fetchMock.mock.calls.find(([reqUrl]) => String(reqUrl).includes('/time_tracking_entries'));
  const body = JSON.parse(String((call as [unknown, RequestInit])[1].body)) as { data: Record<string, unknown> };
  return body.data;
};

describe('asana duration conversion', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    resetSharedClient();
  });

  it('converts task.duration (seconds) to whole minutes', async () => {
    const fetchMock = installFetch();
    const result = await syncTaskToExternal({ taskId: 'task-1' }, buildContext(baseTask));

    expect(result.status).toBe('synced');
    // 3600s tracked = 60 minutes, not 3600/60000 ≈ 0.
    expect(readEntryPayload(fetchMock).duration_minutes).toBe(60);
  });

  it('subtracts break seconds before converting to minutes', async () => {
    const fetchMock = installFetch();
    const task: TaskDto = { ...baseTask, duration: 3600, durationBreak: 600 };
    const result = await syncTaskToExternal({ taskId: 'task-1' }, buildContext(task));

    expect(result.status).toBe('synced');
    // (3600 - 600)s = 3000s = 50 minutes.
    expect(readEntryPayload(fetchMock).duration_minutes).toBe(50);
  });

  it('falls back to start/end and scales the break to milliseconds', async () => {
    const fetchMock = installFetch();
    // duration 0 forces the start/end fallback branch; 1h span minus a 600s break.
    const task: TaskDto = { ...baseTask, duration: 0, durationBreak: 600 };
    const result = await syncTaskToExternal({ taskId: 'task-1' }, buildContext(task));

    expect(result.status).toBe('synced');
    expect(readEntryPayload(fetchMock).duration_minutes).toBe(50);
  });
});
