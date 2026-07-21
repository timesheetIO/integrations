import { IntegrationContext } from '@timesheet/integration-sdk';
import { runFullSync } from '../google-health/src/handlers/runFullSync';
import { handleSyncBatch } from '../google-health/src/handlers/handleSyncBatch';
import { testConnection } from '../google-health/src/handlers/testConnection';

/** Raw DataPoint as returned by GET /v4/users/me/dataTypes/exercise/dataPoints. */
const runDataPoint = (overrides: Record<string, unknown> = {}) => ({
  name: 'users/me/dataTypes/exercise/dataPoints/dp-run-1',
  dataSource: { recordingMethod: 'AUTOMATICALLY_RECORDED', platform: 'PIXEL_WATCH' },
  exercise: {
    interval: {
      startTime: '2026-03-01T07:00:00Z',
      endTime: '2026-03-01T07:45:00Z',
      startUtcOffset: '3600s',
      endUtcOffset: '3600s'
    },
    exerciseType: 'RUNNING',
    displayName: 'Morning Run',
    activeDuration: '2700s',
    metricsSummary: {
      caloriesKcal: 350,
      distanceMillimeters: 5000000,
      steps: '6000'
    }
  },
  ...overrides
});

const createFetchResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: 'OK',
  headers: { forEach: () => {} },
  json: async () => body,
  text: async () => JSON.stringify(body)
});

interface ContextOptions {
  lastSyncTime?: string | null;
  config?: Record<string, unknown>;
  exerciseTypeMappings?: Array<{ localId: string; externalId: string; syncStatus: string }>;
  existingWorkoutIds?: string[];
  createTaskError?: Error;
}

const createContext = (options: ContextOptions = {}) => {
  const createTask = jest.fn().mockImplementation(async (input: Record<string, unknown>) => {
    if (options.createTaskError) {
      throw options.createTaskError;
    }
    return { id: 'task-' + String(input.description), ...input };
  });
  const upsert = jest.fn();
  const mappingDelete = jest.fn();
  const stateSet = jest.fn();
  const existingWorkouts = new Set(options.existingWorkoutIds ?? []);

  const context = {
    userId: 'user-1',
    installationId: 'installation-1',
    config: options.config ?? {},
    data: { createTask },
    credentials: {
      getAccessToken: jest.fn().mockResolvedValue('token'),
      refreshToken: jest.fn().mockResolvedValue('token-2')
    },
    mappings: {
      get: jest.fn().mockResolvedValue(null),
      findByExternal: jest.fn().mockImplementation(async (input: { externalId: string }) =>
        existingWorkouts.has(input.externalId)
          ? { localId: 'task-existing', externalId: input.externalId, syncStatus: 'SYNCED' }
          : null
      ),
      list: jest.fn().mockImplementation(async (input: { entity: string }) =>
        input.entity === 'exercise_type' ? options.exerciseTypeMappings ?? [] : []
      ),
      upsert,
      delete: mappingDelete
    },
    state: {
      get: jest.fn().mockImplementation(async (key: string) =>
        key === 'lastSyncTime' ? options.lastSyncTime ?? null : null
      ),
      set: stateSet,
      delete: jest.fn()
    },
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  } as unknown as IntegrationContext;

  return { context, createTask, upsert, mappingDelete, stateSet };
};

const mockExerciseFetch = (dataPoints: unknown[]) => {
  const fetchMock = jest.fn(async (url: RequestInfo | URL) => {
    const requestUrl = String(url);
    if (requestUrl.includes('health.googleapis.com') && requestUrl.includes('/identity')) {
      return createFetchResponse({ fitbitUserId: 'fitbit-1', googleUserId: 'google-1' });
    }
    if (requestUrl.includes('health.googleapis.com') && requestUrl.includes('/dataTypes/exercise/dataPoints')) {
      return createFetchResponse({ dataPoints });
    }
    return createFetchResponse({});
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
};

describe('google-health plugin', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('connects via the identity endpoint', async () => {
    mockExerciseFetch([]);
    const { context } = createContext();

    const result = await testConnection(undefined, context);

    expect(result).toEqual({ system: 'google-health', ok: true, installationId: 'installation-1' });
  });

  it('imports a mapped workout as a task and records the workout mapping', async () => {
    mockExerciseFetch([runDataPoint()]);
    const { context, createTask, upsert, stateSet } = createContext({
      config: { syncTagId: 'tag-1' },
      exerciseTypeMappings: [{ localId: 'project-run', externalId: 'RUNNING', syncStatus: 'SYNCED' }]
    });

    const result = await runFullSync(undefined, context);

    expect(result.status).toBe('completed');
    expect(result.syncedCount).toBe(1);
    expect(createTask).toHaveBeenCalledWith({
      projectId: 'project-run',
      startDateTime: '2026-03-01T07:00:00Z',
      endDateTime: '2026-03-01T07:45:00Z',
      description: 'Morning Run (Google Health)',
      tagIds: ['tag-1']
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        system: 'google-health',
        entity: 'workout',
        externalId: 'users/me/dataTypes/exercise/dataPoints/dp-run-1',
        metadata: expect.objectContaining({
          exerciseType: 'RUNNING',
          caloriesKcal: 350,
          distanceMillimeters: 5000000
        }),
        syncStatus: 'SYNCED'
      })
    );
    expect(stateSet).toHaveBeenCalledWith('lastSyncTime', expect.any(String));
  });

  it('requests exercises with the documented filter syntax and page size', async () => {
    const fetchMock = mockExerciseFetch([]);
    const { context } = createContext({ lastSyncTime: '2026-03-05T12:00:00.000Z' });

    await runFullSync(undefined, context);

    const listCall = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .find((url) => url.includes('/dataTypes/exercise/dataPoints'));
    expect(listCall).toBeDefined();
    const query = new URL(listCall as string).searchParams;
    expect(query.get('pageSize')).toBe('25');
    expect(query.get('filter')).toMatch(/^exercise\.interval\.civil_start_time >= "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}"$/);
  });

  it('re-scans a 48h overlap window before the stored cursor', async () => {
    const fetchMock = mockExerciseFetch([]);
    const { context } = createContext({ lastSyncTime: '2026-03-05T12:00:00.000Z' });

    await runFullSync(undefined, context);

    const listCall = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .find((url) => url.includes('/dataTypes/exercise/dataPoints'));
    const filter = new URL(listCall as string).searchParams.get('filter') as string;
    // 48h overlap before the cursor, plus the 12h civil-time skew widening.
    expect(filter).toContain('2026-03-03T00:00:00');
  });

  it('skips workouts that were already imported', async () => {
    mockExerciseFetch([runDataPoint()]);
    const { context, createTask } = createContext({
      exerciseTypeMappings: [{ localId: 'project-run', externalId: 'RUNNING', syncStatus: 'SYNCED' }],
      existingWorkoutIds: ['users/me/dataTypes/exercise/dataPoints/dp-run-1']
    });

    const result = await runFullSync(undefined, context);

    expect(result.status).toBe('completed');
    expect(result.syncedCount).toBe(0);
    expect(result.details?.skippedAlreadySynced).toBe(1);
    expect(createTask).not.toHaveBeenCalled();
  });

  it('uses the fallback project for unmapped exercise types and skips without one', async () => {
    mockExerciseFetch([runDataPoint()]);
    const withFallback = createContext({ config: { fallbackProjectId: 'project-fallback' } });

    const fallbackResult = await runFullSync(undefined, withFallback.context);

    expect(fallbackResult.syncedCount).toBe(1);
    expect(withFallback.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-fallback' })
    );

    mockExerciseFetch([runDataPoint()]);
    const withoutFallback = createContext();

    const skippedResult = await runFullSync(undefined, withoutFallback.context);

    expect(skippedResult.status).toBe('completed');
    expect(skippedResult.syncedCount).toBe(0);
    expect(skippedResult.details?.skippedNoMapping).toBe(1);
    expect(withoutFallback.createTask).not.toHaveBeenCalled();
  });

  it('drops data points without an exercise payload or interval times', async () => {
    mockExerciseFetch([
      { name: 'dp-no-exercise' },
      runDataPoint({ exercise: { exerciseType: 'RUNNING' } }),
      runDataPoint()
    ]);
    const { context } = createContext({ config: { fallbackProjectId: 'project-fallback' } });

    const result = await runFullSync(undefined, context);

    expect(result.syncedCount).toBe(1);
  });

  it('reports partial and keeps the cursor when an import fails, so it is retried', async () => {
    mockExerciseFetch([runDataPoint()]);
    const { context, stateSet } = createContext({
      config: { fallbackProjectId: 'project-fallback' },
      createTaskError: new Error('project gone')
    });

    const result = await runFullSync(undefined, context);

    expect(result.status).toBe('partial');
    expect(result.details?.errors).toHaveLength(1);
    expect(stateSet).not.toHaveBeenCalled();
  });

  it('clears the workout mapping when an imported task is deleted', async () => {
    const { context, mappingDelete } = createContext();
    (context.mappings.get as jest.Mock).mockResolvedValue({
      localId: 'task-1',
      externalId: 'users/me/dataTypes/exercise/dataPoints/dp-run-1',
      syncStatus: 'SYNCED'
    });

    const result = await handleSyncBatch(
      {
        triggerId: 'timesheet-changed',
        mode: 'sync',
        sinceVersion: 1,
        headVersion: 2,
        hasMore: false,
        changes: [
          { version: 2, entityType: 'task', entityId: 'task-1', op: 'DELETE', item: {}, eventTime: 1 },
          { version: 2, entityType: 'task', entityId: 'task-2', op: 'UPSERT', item: {}, eventTime: 1 },
          { version: 2, entityType: 'project', entityId: 'project-1', op: 'DELETE', item: {}, eventTime: 1 }
        ]
      },
      context
    );

    expect(result.syncedCount).toBe(1);
    expect(mappingDelete).toHaveBeenCalledTimes(1);
    expect(mappingDelete).toHaveBeenCalledWith({
      system: 'google-health',
      entity: 'workout',
      localId: 'task-1'
    });
  });
});
