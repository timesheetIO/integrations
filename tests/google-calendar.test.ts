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
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
      description: 'Imported'
    }));
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ externalId: 'event-1' }));
    expect(requestedUrl.searchParams.has('updatedMin')).toBe(true);
    expect(requestedUrl.searchParams.has('timeMin')).toBe(false);
    expect(stateSet).toHaveBeenCalledWith('google-calendar:sync-token:calendar-1', 'next-token');
  });

  it('skips echoing a task change that was just imported from Google Calendar', async () => {
    const fetchMock = jest.fn();
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

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
          .mockResolvedValueOnce({
            localId: 'task-1',
            externalId: 'event-1',
            syncStatus: 'SYNCED',
            metadata: {
              calendarId: 'calendar-1',
              updated: '2026-02-20T11:10:00Z',
              timesheetUpdatedAt: String(baseTask.lastUpdate)
            }
          }),
        upsert: jest.fn(),
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

    const result = await syncTaskToExternal({ taskId: 'task-1' }, context);

    expect(result.status).toBe('skipped');
    expect(result.details).toEqual(expect.objectContaining({ reason: 'already-synced-task-change' }));
    expect(fetchMock).not.toHaveBeenCalled();
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

  it('keeps the task description when updating from a Timesheet-originated event', async () => {
    const getTask = jest.fn().mockResolvedValue({
      id: 'task-1',
      lastUpdate: Date.parse('2026-02-20T10:00:00Z')
    });
    const updateTask = jest.fn().mockResolvedValue({
      id: 'task-1',
      lastUpdate: Date.parse('2026-02-20T11:15:00Z')
    });

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
            updated: '2026-02-20T11:00:00Z'
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
            summary: 'Client Work - Acme',
            description: 'Calendar sync task',
            start: { dateTime: '2026-02-20T12:00:00Z' },
            end: { dateTime: '2026-02-20T13:00:00Z' },
            updated: '2026-02-20T11:10:00Z',
            extendedProperties: { private: { timesheetId: 'task-1' } }
          }
        ],
        nextSyncToken: 'next-token'
      }),
      text: async () => '{}'
    });

    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as typeof fetch;

    const result = await runFullSync(undefined, context);

    expect(result.syncedCount).toBe(1);
    expect(updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({
      description: 'Calendar sync task'
    }));
  });

  it('releases the event import lock when task creation fails', async () => {
    const createTask = jest.fn().mockRejectedValue(new Error('createTask boom'));
    const stateSet = jest.fn().mockResolvedValue(undefined);
    const stateDelete = jest.fn().mockResolvedValue(undefined);

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
        delete: stateDelete
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

    await expect(runFullSync(undefined, context)).rejects.toThrow('createTask boom');

    expect(stateSet).toHaveBeenCalledWith(
      expect.stringMatching(/^google-calendar:event-import:/),
      expect.any(Number),
      { ttlSeconds: 3600, ifAbsent: true }
    );
    expect(stateDelete).toHaveBeenCalledWith(expect.stringMatching(/^google-calendar:event-import:/));
  });

  it('ignores stale-channel webhooks when a newer channel is stored', async () => {
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

    const result = await handleGoogleWebhook({
      headers: {
        'x-goog-channel-id': 'stale-channel',
        'x-goog-resource-uri': 'https://www.googleapis.com/calendar/v3/calendars/calendar-1/events?alt=json'
      }
    }, context);

    expect(result.status).toBe('ignored');
    expect(result.details).toEqual(expect.objectContaining({ reason: 'stale-watch-channel' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('routes legacy unmatched-channel webhooks by resource URI and uses a narrow recent update window', async () => {
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
        list: jest.fn().mockResolvedValue([{ localId: 'project-1', externalId: 'calendar-1', syncStatus: 'SYNCED', metadata: {} }]),
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
        'x-goog-channel-id': 'legacy-channel',
        'x-goog-resource-uri': 'https://www.googleapis.com/calendar/v3/calendars/calendar-1/events?alt=json'
      }
    }, context);

    const requestedUrl = new URL(String(fetchMock.mock.calls[0][0]));
    const updatedMin = requestedUrl.searchParams.get('updatedMin');
    expect(result.syncedCount).toBe(1);
    expect(createTask).toHaveBeenCalled();
    expect(requestedUrl.searchParams.has('updatedMin')).toBe(true);
    expect(requestedUrl.searchParams.has('timeMin')).toBe(false);
    expect(updatedMin ? Date.now() - Date.parse(updatedMin) : Number.POSITIVE_INFINITY).toBeLessThan(15 * 60 * 1000);
    expect(stateSet).toHaveBeenCalledWith('google-calendar:sync-token:calendar-1', 'next-token');
  });

  it('uses an event import lock to avoid duplicate Timesheet tasks from repeated webhook scans', async () => {
    const createTask = jest.fn();
    const stateSet = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Timesheet API request failed (409) PUT /state: StateConflict'));

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
    expect(createTask).not.toHaveBeenCalled();
    expect(stateSet).toHaveBeenCalledWith(
      expect.stringMatching(/^google-calendar:event-import:/),
      expect.any(Number),
      { ttlSeconds: 3600, ifAbsent: true }
    );
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
