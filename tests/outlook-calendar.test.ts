import { IntegrationContext, MappingRecord, TaskDto } from '@timesheet/integration-sdk';
import { handleSyncBatch } from '../outlook-calendar/src/handlers/handleSyncBatch';
import { handleWebhook } from '../outlook-calendar/src/handlers/handleWebhook';
import { renewSubscriptions } from '../outlook-calendar/src/handlers/renewSubscriptions';
import { runFullSync } from '../outlook-calendar/src/handlers/runFullSync';
import { syncTaskToExternal } from '../outlook-calendar/src/handlers/syncTaskToExternal';
import { TIMESHEET_ID_PROPERTY } from '../outlook-calendar/src/lib/outlookCalendarClient';
import { formatInZone, parseGraphDateTime, toGraphDateTime } from '../outlook-calendar/src/lib/time';

const WEBHOOK_URL = 'https://worker.timesheet.io/hooks/integration/endpoint-1';
const SUBSCRIPTION_KEY = 'outlook-calendar:subscription';
const LOCK_KEY = 'outlook-calendar:sync-lock';
const PENDING_KEY = 'outlook-calendar:sync-pending';

interface GraphCall {
  method: string;
  url: URL;
  body?: Record<string, unknown>;
  headers: Record<string, string>;
}

interface Reply {
  reply: true;
  status: number;
  body?: unknown;
}

const reply = (status: number, body?: unknown): Reply => ({ reply: true, status, body });

type Routes = Record<string, (call: GraphCall) => unknown>;

/** Routes Graph calls by "METHOD /path" (without /v1.0) and records them. */
function mockGraph(routes: Routes): GraphCall[] {
  const calls: GraphCall[] = [];
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const call: GraphCall = {
      method,
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>
    };
    calls.push(call);
    const key = `${method} ${decodeURIComponent(url.pathname.replace('/v1.0', ''))}`;
    const handler = routes[key];
    if (!handler) {
      throw new Error(`Unexpected Graph call ${key}`);
    }
    const result = handler(call);
    const { status, body } = (result as Reply)?.reply ? result as Reply : { status: 200, body: result };
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      headers: { get: () => null, forEach: () => {} },
      json: async () => body,
      text: async () => JSON.stringify(body ?? {})
    };
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  return calls;
}

const project = {
  id: 'project-1',
  user: 'user-1',
  title: 'Client Work',
  employer: 'Acme',
  archived: false,
  deleted: false,
  lastUpdate: 0,
  created: 0,
  duration: 0,
  durationBreak: 0,
  salaryTotal: '0',
  salaryBreak: '0',
  expenses: '0',
  expensesPaid: '0',
  mileage: '0'
};

function task(overrides: Partial<TaskDto> = {}): TaskDto {
  return {
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
    lastUpdate: 2_000,
    created: 1_000,
    description: 'Design review',
    location: 'Vienna',
    startDateTime: '2026-07-01T10:00:00+02:00',
    endDateTime: '2026-07-01T11:30:00+02:00',
    project,
    ...overrides
  };
}

function outlookEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'event-1',
    subject: 'Kickoff',
    body: { contentType: 'text', content: 'Agenda\r\n' },
    location: { displayName: 'Room 4' },
    start: { dateTime: '2026-07-01T08:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-07-01T09:00:00.0000000', timeZone: 'UTC' },
    type: 'singleInstance',
    isCancelled: false,
    lastModifiedDateTime: '2026-07-01T07:00:00.1234567Z',
    changeKey: 'ck-1',
    ...overrides
  };
}

function createContext(options: {
  config?: Record<string, unknown>;
  taskMappings?: MappingRecord[];
  state?: Record<string, unknown>;
  tasks?: Record<string, TaskDto>;
  timezone?: string;
} = {}) {
  const state = new Map<string, unknown>(Object.entries(options.state ?? {}));
  const projectMappings: MappingRecord[] = [{ localId: 'project-1', externalId: 'cal-1', syncStatus: 'SYNCED' }];
  const taskMappings: MappingRecord[] = [...(options.taskMappings ?? [])];
  const tasks: Record<string, TaskDto> = { ...(options.tasks ?? {}) };
  const listFor = (entity: string) => (entity === 'project' ? projectMappings : taskMappings);

  const data = {
    getTask: jest.fn(async (id: string) => tasks[id] ?? task({ id })),
    getProject: jest.fn(async () => project),
    createTask: jest.fn(async (input: Record<string, unknown>) => ({ ...task({ id: 'task-new', lastUpdate: 5_000 }), ...input })),
    updateTask: jest.fn(async (id: string, input: Record<string, unknown>) => ({ ...task({ id, lastUpdate: 6_000 }), ...input })),
    deleteTask: jest.fn(async () => undefined),
    getSettings: jest.fn(async () => ({ lastUpdate: 0, timezone: options.timezone ?? 'Europe/Vienna' }))
  };
  const mappings = {
    list: jest.fn(async ({ entity }: { entity: string }) => [...listFor(entity)]),
    get: jest.fn(async ({ entity, localId }: { entity: string; localId: string }) =>
      listFor(entity).find(mapping => mapping.localId === localId) ?? null),
    findByExternal: jest.fn(async () => null),
    upsert: jest.fn(async (input: MappingRecord & { entity: string }) => {
      const list = listFor(input.entity);
      const index = list.findIndex(mapping => mapping.localId === input.localId);
      if (index >= 0) list.splice(index, 1);
      list.push(input);
    }),
    delete: jest.fn(async ({ entity, localId }: { entity: string; localId: string }) => {
      const list = listFor(entity);
      const index = list.findIndex(mapping => mapping.localId === localId);
      if (index >= 0) list.splice(index, 1);
    })
  };
  const stateClient = {
    get: jest.fn(async (key: string) => (state.has(key) ? state.get(key) : null)),
    set: jest.fn(async (key: string, value: unknown, opts?: { ifAbsent?: boolean }) => {
      if (opts?.ifAbsent && state.has(key)) {
        throw new Error('Timesheet API request failed (409)');
      }
      state.set(key, value);
    }),
    delete: jest.fn(async (key: string) => {
      state.delete(key);
    })
  };

  const context = {
    userId: 'user-1',
    installationId: 'installation-1',
    config: options.config ?? {},
    data,
    credentials: {
      getAccessToken: jest.fn(async () => 'token'),
      refreshToken: jest.fn(async () => 'token-2')
    },
    mappings,
    state: stateClient,
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    metadata: { webhooks: { 'integration-webhook': WEBHOOK_URL } }
  } as unknown as IntegrationContext;

  return { context, data, mappings, state, taskMappings };
}

const currentSubscription = (overrides: Record<string, unknown> = {}) => ({
  id: 'sub-1',
  clientState: 'secret-state',
  notificationUrl: WEBHOOK_URL,
  expirationDateTime: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString(),
  ...overrides
});

describe('outlook-calendar time conversion', () => {
  it('reads Graph UTC wall clocks with seven fraction digits', () => {
    expect(parseGraphDateTime({ dateTime: '2026-07-01T08:00:00.0000000', timeZone: 'UTC' }))
      .toBe(Date.parse('2026-07-01T08:00:00Z'));
  });

  it('writes imported times in the user zone, including daylight saving', () => {
    expect(formatInZone(Date.parse('2026-07-01T08:00:00Z'), 'Europe/Vienna')).toBe('2026-07-01T10:00:00+02:00');
    expect(formatInZone(Date.parse('2026-01-15T08:00:00Z'), 'Europe/Vienna')).toBe('2026-01-15T09:00:00+01:00');
    expect(formatInZone(Date.parse('2026-01-15T08:00:00Z'), 'America/New_York')).toBe('2026-01-15T03:00:00-05:00');
  });

  it('falls back to UTC for an unknown zone', () => {
    expect(formatInZone(Date.parse('2026-07-01T08:00:00Z'), 'W. Europe Standard Time')).toBe('2026-07-01T08:00:00+00:00');
    expect(formatInZone(Date.parse('2026-07-01T08:00:00Z'), undefined)).toBe('2026-07-01T08:00:00+00:00');
  });

  it('sends task times to Graph as UTC', () => {
    expect(toGraphDateTime('2026-07-01T10:00:00+02:00')).toEqual({ dateTime: '2026-07-01T08:00:00', timeZone: 'UTC' });
  });
});

describe('outlook-calendar Timesheet to Outlook', () => {
  it('creates a stamped event with the project title for a new task', async () => {
    const { context, mappings } = createContext({ tasks: { 'task-1': task() } });
    const calls = mockGraph({
      'GET /me/events': () => ({ value: [] }),
      'POST /me/calendars/cal-1/events': () => outlookEvent({ id: 'event-9', subject: 'Client Work - Acme' })
    });

    const result = await syncTaskToExternal({ taskId: 'task-1' }, context);

    expect(result.status).toBe('synced');
    const lookup = calls[0].url.searchParams.get('$filter');
    expect(lookup).toContain(TIMESHEET_ID_PROPERTY);
    expect(lookup).toContain("ep/value eq 'task-1'");
    const created = calls[1].body!;
    expect(created.subject).toBe('Client Work - Acme');
    expect(created.body).toEqual({ contentType: 'text', content: 'Design review' });
    expect(created.start).toEqual({ dateTime: '2026-07-01T08:00:00', timeZone: 'UTC' });
    expect(created.end).toEqual({ dateTime: '2026-07-01T09:30:00', timeZone: 'UTC' });
    expect(created.singleValueExtendedProperties).toEqual([{ id: TIMESHEET_ID_PROPERTY, value: 'task-1' }]);
    expect(calls[1].headers.Prefer).toContain('IdType="ImmutableId"');
    expect(mappings.upsert).toHaveBeenCalledWith(expect.objectContaining({
      entity: 'task',
      localId: 'task-1',
      externalId: 'event-9',
      metadata: expect.objectContaining({ origin: 'timesheet', updated: '2026-07-01T07:00:00.1234567Z' })
    }));
  });

  it('skips the echo of a change it just imported', async () => {
    const { context } = createContext({
      tasks: { 'task-1': task({ lastUpdate: 5_000 }) },
      taskMappings: [{
        localId: 'task-1',
        externalId: 'event-1',
        metadata: { origin: 'outlook', timesheetUpdatedAt: '5000' },
        syncStatus: 'SYNCED'
      }]
    });
    const calls = mockGraph({});

    const result = await syncTaskToExternal({ taskId: 'task-1' }, context);

    expect(result.details?.reason).toBe('already-synced-task-change');
    expect(calls).toHaveLength(0);
  });

  it('keeps the subject and body of an Outlook-originated event', async () => {
    const { context } = createContext({
      tasks: { 'task-1': task({ description: 'Renamed in Timesheet' }) },
      taskMappings: [{ localId: 'task-1', externalId: 'event-1', metadata: { origin: 'outlook' }, syncStatus: 'SYNCED' }]
    });
    const calls = mockGraph({ 'PATCH /me/events/event-1': () => outlookEvent() });

    await syncTaskToExternal({ taskId: 'task-1' }, context);

    const patch = calls[0].body!;
    expect(patch.subject).toBe('Renamed in Timesheet');
    expect(patch.body).toBeUndefined();
    expect(patch.singleValueExtendedProperties).toEqual([{ id: TIMESHEET_ID_PROPERTY, value: 'task-1' }]);
  });

  it('only writes times and location when the origin is unknown', async () => {
    const { context } = createContext({
      tasks: { 'task-1': task() },
      taskMappings: [{ localId: 'task-1', externalId: 'event-1', metadata: {}, syncStatus: 'SYNCED' }]
    });
    const calls = mockGraph({ 'PATCH /me/events/event-1': () => outlookEvent() });

    await syncTaskToExternal({ taskId: 'task-1' }, context);

    expect(Object.keys(calls[0].body!).sort()).toEqual(['end', 'location', 'start']);
  });

  it('deletes the event when the task is deleted', async () => {
    const { context, mappings } = createContext({
      tasks: { 'task-1': task({ deleted: true }) },
      taskMappings: [{ localId: 'task-1', externalId: 'event-1', metadata: {}, syncStatus: 'SYNCED' }]
    });
    const calls = mockGraph({ 'DELETE /me/events/event-1': () => reply(204) });

    const result = await syncTaskToExternal({ taskId: 'task-1' }, context);

    expect(result.status).toBe('deleted');
    expect(calls[0].method).toBe('DELETE');
    expect(mappings.delete).toHaveBeenCalledWith({ system: 'outlook-calendar', entity: 'task', localId: 'task-1' });
  });

  it('creates the subscription after the last sync batch', async () => {
    const { context, state } = createContext({ tasks: { 'task-1': task() } });
    const calls = mockGraph({
      'GET /me/events': () => ({ value: [] }),
      'POST /me/calendars/cal-1/events': () => outlookEvent({ id: 'event-9' }),
      'POST /subscriptions': () => ({ id: 'sub-new', expirationDateTime: '2026-07-08T00:00:00Z' })
    });

    const result = await handleSyncBatch({
      triggerId: 'task-changed',
      mode: 'sync',
      sinceVersion: 1,
      headVersion: 2,
      hasMore: false,
      changes: [{ version: 2, entityType: 'task', entityId: 'task-1', op: 'UPSERT', eventTime: 0, item: { id: 'task-1', projectId: 'project-1', startDateTime: '2026-07-01T10:00:00+02:00', endDateTime: '2026-07-01T11:00:00+02:00', lastUpdate: 2_000 } }]
    }, context);

    expect(result.syncedCount).toBe(1);
    const subscription = calls.find(call => call.url.pathname.endsWith('/subscriptions'))!;
    expect(subscription.body).toEqual(expect.objectContaining({
      changeType: 'created,updated,deleted',
      resource: 'me/events',
      notificationUrl: WEBHOOK_URL
    }));
    expect(String(subscription.body!.clientState).length).toBeLessThanOrEqual(128);
    expect(state.get(SUBSCRIPTION_KEY)).toEqual(expect.objectContaining({ id: 'sub-new', notificationUrl: WEBHOOK_URL }));
  });
});

describe('outlook-calendar Outlook to Timesheet', () => {
  it('imports a new event in the user zone, stamps it and stores the feed link', async () => {
    const { context, data, mappings, state } = createContext();
    const stamped = outlookEvent({ lastModifiedDateTime: '2026-07-01T07:05:00Z', changeKey: 'ck-2' });
    const calls = mockGraph({
      'GET /me/calendars/cal-1/calendarView/delta': () => ({
        value: [outlookEvent()],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView/delta?$deltatoken=t1'
      }),
      'GET /me/events/event-1': () => outlookEvent(),
      'PATCH /me/events/event-1': () => stamped
    });

    const result = await runFullSync(undefined, context);

    expect(result.syncedCount).toBe(1);
    const feed = calls[0];
    expect(feed.url.searchParams.get('startDateTime')).toBeTruthy();
    expect(feed.url.searchParams.get('endDateTime')).toBeTruthy();
    expect(feed.headers.Prefer).toContain('outlook.timezone="UTC"');
    expect(feed.headers.Prefer).toContain('odata.maxpagesize=100');
    expect(calls[1].url.searchParams.get('$expand')).toContain(TIMESHEET_ID_PROPERTY);
    expect(data.createTask).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      startDateTime: '2026-07-01T10:00:00+02:00',
      endDateTime: '2026-07-01T11:00:00+02:00',
      description: 'Kickoff',
      location: 'Room 4'
    }));
    expect(calls[2].body).toEqual({ singleValueExtendedProperties: [{ id: TIMESHEET_ID_PROPERTY, value: 'task-new' }] });
    expect(mappings.upsert).toHaveBeenCalledWith(expect.objectContaining({
      localId: 'task-new',
      externalId: 'event-1',
      metadata: expect.objectContaining({ origin: 'outlook', updated: '2026-07-01T07:05:00Z' })
    }));
    const [deltaKey] = [...state.keys()].filter(key => key.startsWith('outlook-calendar:delta:'));
    expect(state.get(deltaKey)).toEqual(expect.objectContaining({
      deltaLink: 'https://graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView/delta?$deltatoken=t1'
    }));
    expect(state.has(LOCK_KEY)).toBe(false);
  });

  it('does not import an event that already carries a Timesheet stamp', async () => {
    const { context, data } = createContext();
    mockGraph({
      'GET /me/calendars/cal-1/calendarView/delta': () => ({ value: [outlookEvent()], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/d' }),
      'GET /me/events/event-1': () => outlookEvent({
        singleValueExtendedProperties: [{ id: TIMESHEET_ID_PROPERTY, value: 'task-old' }]
      })
    });

    const result = await runFullSync(undefined, context);

    expect(result.syncedCount).toBe(0);
    expect(data.createTask).not.toHaveBeenCalled();
  });

  it('does not stamp one occurrence of a series', async () => {
    const { context, data } = createContext();
    const calls = mockGraph({
      'GET /me/calendars/cal-1/calendarView/delta': () => ({ value: [outlookEvent({ type: 'occurrence' })], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/d' }),
      'GET /me/events/event-1': () => outlookEvent({ type: 'occurrence' })
    });

    await runFullSync(undefined, context);

    expect(data.createTask).toHaveBeenCalledTimes(1);
    expect(calls.some(call => call.method === 'PATCH')).toBe(false);
  });

  it('releases the import lock when task creation fails', async () => {
    const { context, data, state } = createContext();
    data.createTask.mockRejectedValueOnce(new Error('boom'));
    mockGraph({
      'GET /me/calendars/cal-1/calendarView/delta': () => ({ value: [outlookEvent()], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/d' }),
      'GET /me/events/event-1': () => outlookEvent()
    });

    await expect(runFullSync(undefined, context)).rejects.toThrow('boom');

    expect([...state.keys()].some(key => key.startsWith('outlook-calendar:event-import:'))).toBe(false);
    expect(state.has(LOCK_KEY)).toBe(false);
  });

  it('skips a mapped event that has not changed since the last sync', async () => {
    const { context, data } = createContext({
      taskMappings: [{
        localId: 'task-1',
        externalId: 'event-1',
        metadata: { origin: 'outlook', updated: '2026-07-01T07:00:00.1234567Z' },
        syncStatus: 'SYNCED'
      }]
    });
    mockGraph({
      'GET /me/calendars/cal-1/calendarView/delta': () => ({ value: [outlookEvent()], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/d' })
    });

    const result = await runFullSync(undefined, context);

    expect(result.syncedCount).toBe(0);
    expect(data.updateTask).not.toHaveBeenCalled();
  });

  it('reads the task description from the body of a Timesheet-originated event', async () => {
    const { context, data } = createContext({
      tasks: { 'task-1': task({ lastUpdate: 1_000 }) },
      taskMappings: [{
        localId: 'task-1',
        externalId: 'event-1',
        metadata: { origin: 'timesheet', updated: '2026-06-30T00:00:00Z' },
        syncStatus: 'SYNCED'
      }]
    });
    mockGraph({
      'GET /me/calendars/cal-1/calendarView/delta': () => ({
        value: [outlookEvent({ subject: 'Client Work - Acme', body: { contentType: 'text', content: 'Moved later\r\n' } })],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/d'
      })
    });

    await runFullSync(undefined, context);

    expect(data.updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({
      description: 'Moved later',
      startDateTime: '2026-07-01T10:00:00+02:00'
    }));
  });

  it('deletes the task of a removed event that is gone, but keeps one that only left the window', async () => {
    const { context, data, mappings } = createContext({
      taskMappings: [
        { localId: 'task-1', externalId: 'event-1', metadata: {}, syncStatus: 'SYNCED' },
        { localId: 'task-2', externalId: 'event-2', metadata: {}, syncStatus: 'SYNCED' }
      ]
    });
    mockGraph({
      'GET /me/calendars/cal-1/calendarView/delta': () => ({
        value: [
          { id: 'event-1', '@removed': { reason: 'deleted' } },
          { id: 'event-2', '@removed': { reason: 'deleted' } }
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/d'
      }),
      'GET /me/events/event-1': () => reply(404, { error: { code: 'ErrorItemNotFound' } }),
      'GET /me/events/event-2': () => outlookEvent({ id: 'event-2' })
    });

    await runFullSync(undefined, context);

    expect(data.deleteTask).toHaveBeenCalledTimes(1);
    expect(data.deleteTask).toHaveBeenCalledWith('task-1');
    expect(mappings.delete).toHaveBeenCalledWith({ system: 'outlook-calendar', entity: 'task', localId: 'task-1' });
  });

  it('starts a new feed when Graph no longer knows the stored link', async () => {
    const { context, state } = createContext();
    // A first run stores the link.
    mockGraph({
      'GET /me/calendars/cal-1/calendarView/delta': () => ({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView/delta?$deltatoken=old' })
    });
    await runFullSync(undefined, context);
    const [deltaKey] = [...state.keys()].filter(key => key.startsWith('outlook-calendar:delta:'));

    const calls = mockGraph({
      'GET /me/calendars/cal-1/calendarView/delta': call => call.url.searchParams.get('$deltatoken') === 'old'
        ? reply(410, { error: { code: 'SyncStateNotFound' } })
        : { value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView/delta?$deltatoken=new' }
    });
    await runFullSync(undefined, context);

    const feedCalls = calls.filter(call => call.url.pathname.endsWith('/calendarView/delta'));
    expect(feedCalls).toHaveLength(2);
    expect(feedCalls[1].url.searchParams.get('startDateTime')).toBeTruthy();
    expect((state.get(deltaKey) as { deltaLink: string }).deltaLink).toContain('$deltatoken=new');
  });

  it('leaves a note instead of syncing while another run holds the lock', async () => {
    const { context, data, state } = createContext({ state: { [LOCK_KEY]: Date.now() } });
    const calls = mockGraph({});

    const result = await runFullSync(undefined, context);

    expect(result.status).toBe('deferred');
    expect(state.has(PENDING_KEY)).toBe(true);
    expect(calls.filter(call => call.url.pathname.includes('/calendars/'))).toHaveLength(0);
    expect(data.createTask).not.toHaveBeenCalled();
  });

  it('runs another pass when a note arrives during the sync', async () => {
    const { context, state } = createContext();
    let feedReads = 0;
    mockGraph({
      'GET /me/calendars/cal-1/calendarView/delta': () => {
        feedReads += 1;
        if (feedReads === 1) {
          // A notification arrives mid-sync and leaves its note.
          state.set(PENDING_KEY, Date.now());
        }
        return { value: [], '@odata.deltaLink': `https://graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView/delta?$deltatoken=${feedReads}` };
      }
    });

    const result = await runFullSync(undefined, context);

    expect(feedReads).toBe(2);
    expect(result.details?.rounds).toBe(2);
    expect(state.has(PENDING_KEY)).toBe(false);
  });
});

describe('outlook-calendar notifications', () => {
  it('ignores notifications whose clientState does not match', async () => {
    const { context } = createContext({ state: { [SUBSCRIPTION_KEY]: currentSubscription() } });
    const calls = mockGraph({});

    const result = await handleWebhook({
      body: { value: [{ subscriptionId: 'sub-1', clientState: 'forged', changeType: 'created' }] }
    }, context);

    expect(result.status).toBe('ignored');
    expect(calls).toHaveLength(0);
  });

  it('runs the change feeds for a verified notification', async () => {
    const { context } = createContext({ state: { [SUBSCRIPTION_KEY]: currentSubscription() } });
    const calls = mockGraph({
      'GET /me/calendars/cal-1/calendarView/delta': () => ({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/d' })
    });

    const result = await handleWebhook({
      body: { value: [{ subscriptionId: 'sub-1', clientState: 'secret-state', changeType: 'updated' }] }
    }, context);

    expect(result.status).toBe('completed');
    expect(result.details?.notifications).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('deletes an older subscription of the installation and ignores its notification', async () => {
    const { context } = createContext({ state: { [SUBSCRIPTION_KEY]: currentSubscription() } });
    const calls = mockGraph({ 'DELETE /subscriptions/sub-old': () => reply(204) });

    const result = await handleWebhook({
      body: JSON.stringify({ value: [{ subscriptionId: 'sub-old', clientState: 'secret-state', changeType: 'updated' }] })
    }, context);

    expect(result.details?.reason).toBe('stale-subscription');
    expect(calls.map(call => `${call.method} ${call.url.pathname}`)).toEqual(['DELETE /v1.0/subscriptions/sub-old']);
  });
});

describe('outlook-calendar subscription renewal', () => {
  it('leaves a subscription alone while it has more than the renewal window left', async () => {
    const { context } = createContext({ state: { [SUBSCRIPTION_KEY]: currentSubscription() } });
    const calls = mockGraph({
      'GET /me/calendars/cal-1/calendarView/delta': () => ({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/d' })
    });

    const result = await renewSubscriptions(undefined, context);

    expect(result.details?.subscription).toBe('current');
    expect(calls.some(call => call.url.pathname.includes('/subscriptions'))).toBe(false);
  });

  it('renews a subscription that expires inside the window, keeping its clientState', async () => {
    const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { context, state } = createContext({ state: { [SUBSCRIPTION_KEY]: currentSubscription({ expirationDateTime: soon }) } });
    const calls = mockGraph({
      'PATCH /subscriptions/sub-1': call => ({ id: 'sub-1', expirationDateTime: call.body!.expirationDateTime }),
      'GET /me/calendars/cal-1/calendarView/delta': () => ({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/d' })
    });

    const result = await renewSubscriptions(undefined, context);

    expect(result.details?.subscription).toBe('renewed');
    const requested = Date.parse(String(calls[0].body!.expirationDateTime));
    expect(requested - Date.now()).toBeLessThanOrEqual(10_080 * 60 * 1000);
    expect(state.get(SUBSCRIPTION_KEY)).toEqual(expect.objectContaining({ id: 'sub-1', clientState: 'secret-state' }));
  });

  it('creates a new subscription when Graph lost the old one', async () => {
    const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { context, state } = createContext({ state: { [SUBSCRIPTION_KEY]: currentSubscription({ expirationDateTime: soon }) } });
    const calls = mockGraph({
      'PATCH /subscriptions/sub-1': () => reply(404, { error: { code: 'ResourceNotFound' } }),
      'POST /subscriptions': () => ({ id: 'sub-2', expirationDateTime: '2026-07-08T00:00:00Z' }),
      'GET /me/calendars/cal-1/calendarView/delta': () => ({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/d' })
    });

    const result = await renewSubscriptions(undefined, context);

    expect(result.details?.subscription).toBe('created');
    expect(calls[1].body!.clientState).toBe('secret-state');
    expect(state.get(SUBSCRIPTION_KEY)).toEqual(expect.objectContaining({ id: 'sub-2', clientState: 'secret-state' }));
  });

  it('does not subscribe when only Timesheet changes are synced', async () => {
    const { context } = createContext({ config: { syncDirection: 'timesheet-to-outlook' } });
    const calls = mockGraph({});

    const result = await renewSubscriptions(undefined, context);

    expect(result.status).toBe('skipped');
    expect(calls).toHaveLength(0);
  });
});
