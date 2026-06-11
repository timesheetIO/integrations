import { IntegrationContext, TaskDto } from '@timesheet/integration-sdk';
import { runFullSync } from '../google-calendar/src/handlers/runFullSync';
import { syncTaskToExternal } from '../google-calendar/src/handlers/syncTaskToExternal';
import { handleGoogleWebhook } from '../google-calendar/src/lib/taskSync';

describe('google-calendar plugin', () => {
  const baseTask: TaskDto = {
    id: 'task-1',
    user: 'user-1',
    running: false,
    paid: false,
    billed: false,
    billable: true,
    duration: 60,
    durationBreak: 0,
    salaryTotal: '0',
    salaryBreak: '0',
    expensesTotal: '0',
    expensesPaid: '0',
    mileage: '0',
    deleted: false,
    lastUpdate: Date.now(),
    created: Date.now(),
    description: 'Calendar sync task',
    location: 'Berlin',
    startDateTime: '2026-02-20T10:00:00.000Z',
    endDateTime: '2026-02-20T11:00:00.000Z',
    project: {
      id: 'project-1',
      user: 'user-1',
      title: 'Client Work',
      archived: false,
      deleted: false,
      lastUpdate: Date.now(),
      created: Date.now(),
      duration: 0,
      durationBreak: 0,
      salaryTotal: '0',
      salaryBreak: '0',
      expenses: '0',
      expensesPaid: '0',
      mileage: '0',
      employer: 'Acme'
    }
  };

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('creates Google Calendar events for mapped tasks', async () => {
    const upsert = jest.fn();

    const context = {
      userId: 'user-1',
      installationId: 'installation-1',
      config: {},
      data: {
        getTask: jest.fn().mockResolvedValue(baseTask)
      },
      credentials: {
        getAccessToken: jest.fn().mockResolvedValue('token'),
        refreshToken: jest.fn().mockResolvedValue('token-2')
      },
      mappings: {
        get: jest
          .fn()
          .mockResolvedValueOnce({ localId: 'project-1', externalId: 'calendar-1', syncStatus: 'SYNCED' })
          .mockResolvedValueOnce(null),
        upsert,
        delete: jest.fn(),
        list: jest.fn(),
        findByExternal: jest.fn()
      },
      state: {
        get: jest.fn(),
        set: jest.fn(),
        delete: jest.fn()
      },
      logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
      }
    } as unknown as IntegrationContext;

    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { forEach: () => {} },
        json: async () => ({ items: [] }),
        text: async () => '{}'
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { forEach: () => {} },
        json: async () => ({ id: 'event-1', summary: 'Client Work', updated: '2026-02-20T11:00:00Z' }),
        text: async () => '{}'
      });

    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as typeof fetch;

    const result = await syncTaskToExternal({ taskId: 'task-1' }, context);

    expect(result.status).toBe('synced');
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      system: 'google-calendar',
      entity: 'task',
      localId: 'task-1',
      externalId: 'event-1'
    }));
  });

  it('imports recently updated external events and stores sync token during manual sync', async () => {
    const createTask = jest.fn().mockResolvedValue({ id: 'task-created' });
    const upsert = jest.fn();
    const stateSet = jest.fn();

    const context = {
      userId: 'user-1',
      installationId: 'installation-1',
      config: {},
      data: {
        createTask,
        getTask: jest.fn(),
        updateTask: jest.fn(),
        deleteTask: jest.fn()
      },
      credentials: {
        getAccessToken: jest.fn().mockResolvedValue('token'),
        refreshToken: jest.fn().mockResolvedValue('token-2')
      },
      mappings: {
        list: jest.fn().mockResolvedValue([{ localId: 'project-1', externalId: 'calendar-1', syncStatus: 'SYNCED' }]),
        findByExternal: jest.fn().mockResolvedValue(null),
        upsert,
        get: jest.fn(),
        delete: jest.fn()
      },
      state: {
        get: jest.fn().mockResolvedValue(null),
        set: stateSet,
        delete: jest.fn()
      },
      logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
      }
    } as unknown as IntegrationContext;

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { forEach: () => {} },
      json: async () => ({
        items: [
          {
            id: 'event-1',
            summary: 'Imported',
            description: 'Created in Google',
            start: { dateTime: '2026-02-20T10:00:00Z' },
            end: { dateTime: '2026-02-20T11:00:00Z' },
            updated: '2026-02-20T11:10:00Z'
          }
        ],
        nextSyncToken: 'next-token'
      }),
      text: async () => '{}'
    });

    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as typeof fetch;

    const result = await runFullSync(undefined, context);
    const requestedUrl = new URL(String(fetchMock.mock.calls[0][0]));

    expect(result.syncedCount).toBe(1);
    expect(createTask).toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ externalId: 'event-1' }));
    expect(requestedUrl.searchParams.has('updatedMin')).toBe(true);
    expect(requestedUrl.searchParams.has('timeMin')).toBe(false);
    expect(stateSet).toHaveBeenCalledWith('google-calendar:sync-token:calendar-1', 'next-token');
  });

  it('skips mapped external events unchanged since the last sync metadata', async () => {
    const getTask = jest.fn();
    const updateTask = jest.fn();

    const context = {
      userId: 'user-1',
      installationId: 'installation-1',
      config: {},
      data: {
        createTask: jest.fn(),
        getTask,
        updateTask,
        deleteTask: jest.fn()
      },
      credentials: {
        getAccessToken: jest.fn().mockResolvedValue('token'),
        refreshToken: jest.fn().mockResolvedValue('token-2')
      },
      mappings: {
        list: jest.fn().mockResolvedValue([{ localId: 'project-1', externalId: 'calendar-1', syncStatus: 'SYNCED' }]),
        findByExternal: jest.fn().mockResolvedValue({
          localId: 'task-1',
          externalId: 'event-1',
          syncStatus: 'SYNCED',
          metadata: {
            calendarId: 'calendar-1',
            updated: '2026-02-20T11:10:00Z'
          }
        }),
        upsert: jest.fn(),
        get: jest.fn(),
        delete: jest.fn()
      },
      state: {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn(),
        delete: jest.fn()
      },
      logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
      }
    } as unknown as IntegrationContext;

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { forEach: () => {} },
      json: async () => ({
        items: [
          {
            id: 'event-1',
            summary: 'Imported',
            description: 'Created in Google',
            start: { dateTime: '2026-02-20T10:00:00Z' },
            end: { dateTime: '2026-02-20T11:00:00Z' },
            updated: '2026-02-20T11:10:00Z'
          }
        ],
        nextSyncToken: 'next-token'
      }),
      text: async () => '{}'
    });

    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as typeof fetch;

    const result = await runFullSync(undefined, context);

    expect(result.syncedCount).toBe(0);
    expect(getTask).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('routes stale-channel webhooks by resource URI and uses a recent update window', async () => {
    const createTask = jest.fn().mockResolvedValue({ id: 'task-created' });
    const stateSet = jest.fn();

    const context = {
      userId: 'user-1',
      installationId: 'installation-1',
      config: {},
      data: {
        createTask,
        getTask: jest.fn(),
        updateTask: jest.fn(),
        deleteTask: jest.fn()
      },
      credentials: {
        getAccessToken: jest.fn().mockResolvedValue('token'),
        refreshToken: jest.fn().mockResolvedValue('token-2')
      },
      mappings: {
        list: jest.fn().mockResolvedValue([{ localId: 'project-1', externalId: 'calendar-1', syncStatus: 'SYNCED' }]),
        findByExternal: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(),
        get: jest.fn(),
        delete: jest.fn()
      },
      state: {
        get: jest.fn().mockResolvedValue(null),
        set: stateSet,
        delete: jest.fn()
      },
      logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
      }
    } as unknown as IntegrationContext;

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { forEach: () => {} },
      json: async () => ({
        items: [
          {
            id: 'event-1',
            summary: 'Imported',
            description: 'Created in Google',
            start: { dateTime: '2026-02-20T10:00:00Z' },
            end: { dateTime: '2026-02-20T11:00:00Z' },
            updated: '2026-02-20T11:10:00Z'
          }
        ],
        nextSyncToken: 'next-token'
      }),
      text: async () => '{}'
    });

    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as typeof fetch;

    const result = await handleGoogleWebhook({
      headers: {
        'x-goog-channel-id': 'stale-channel',
        'x-goog-resource-uri': 'https://www.googleapis.com/calendar/v3/calendars/calendar-1/events?alt=json'
      }
    }, context);

    const requestedUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(result.syncedCount).toBe(1);
    expect(createTask).toHaveBeenCalled();
    expect(requestedUrl.searchParams.has('updatedMin')).toBe(true);
    expect(requestedUrl.searchParams.has('timeMin')).toBe(false);
    expect(stateSet).toHaveBeenCalledWith('google-calendar:sync-token:calendar-1', 'next-token');
  });

  it('skips duplicate webhook delivery while a calendar sync lock is active', async () => {
    const fetchMock = jest.fn();
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const context = {
      userId: 'user-1',
      installationId: 'installation-1',
      config: {},
      data: {
        createTask: jest.fn(),
        getTask: jest.fn(),
        updateTask: jest.fn(),
        deleteTask: jest.fn()
      },
      credentials: {
        getAccessToken: jest.fn().mockResolvedValue('token'),
        refreshToken: jest.fn().mockResolvedValue('token-2')
      },
      mappings: {
        list: jest.fn().mockResolvedValue([
          {
            localId: 'project-1',
            externalId: 'calendar-1',
            syncStatus: 'SYNCED',
            metadata: { watchChannelId: 'active-channel' }
          }
        ]),
        findByExternal: jest.fn(),
        upsert: jest.fn(),
        get: jest.fn(),
        delete: jest.fn()
      },
      state: {
        get: jest.fn(),
        set: jest.fn().mockRejectedValue(new Error('Timesheet API request failed (409) PUT /state: StateConflict')),
        delete: jest.fn()
      },
      logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
      }
    } as unknown as IntegrationContext;

    const result = await handleGoogleWebhook({
      headers: {
        'x-goog-channel-id': 'active-channel',
        'x-goog-resource-uri': 'https://www.googleapis.com/calendar/v3/calendars/calendar-1/events?alt=json'
      }
    }, context);

    expect(result.syncedCount).toBe(0);
    expect(context.state.set).toHaveBeenCalledWith(
      'google-calendar:sync-lock:calendar-1',
      expect.any(Number),
      { ttlSeconds: 900, ifAbsent: true }
    );
    expect(context.state.delete).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
