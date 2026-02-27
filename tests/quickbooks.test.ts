import { IntegrationContext, TaskDto } from '@timesheet/integration-sdk';
import { handleWebhook } from '../quickbooks/src/handlers/handleWebhook';
import { syncTaskToExternal } from '../quickbooks/src/handlers/syncTaskToExternal';

describe('quickbooks plugin', () => {
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
    description: 'Consulting',
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

  it('creates a QuickBooks time activity and upserts task mapping', async () => {
    const upsert = jest.fn();

    const context = {
      userId: 'user-1',
      installationId: 'installation-1',
      config: { sandboxMode: false },
      data: {
        getTask: jest.fn().mockResolvedValue(baseTask)
      },
      credentials: {
        getAccessToken: jest.fn().mockResolvedValue('token'),
        refreshToken: jest.fn().mockResolvedValue('token-2'),
        getConnectionInfo: jest.fn().mockResolvedValue({ connected: true, provider: 'quickbooks', accountId: 'realm-1' })
      },
      mappings: {
        get: jest
          .fn()
          .mockResolvedValueOnce({ localId: 'project-1', externalId: 'customer-1', syncStatus: 'SYNCED' })
          .mockResolvedValueOnce({ localId: 'user-1', externalId: 'employee-1', syncStatus: 'SYNCED' })
          .mockResolvedValueOnce(null),
        delete: jest.fn(),
        findByExternal: jest.fn(),
        list: jest.fn(),
        upsert
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

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { forEach: () => {} },
      json: async () => ({
        TimeActivity: {
          Id: 'ta-1',
          SyncToken: '0',
          TxnDate: '2026-02-20'
        }
      }),
      text: async () => '{}'
    });

    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as typeof fetch;

    const result = await syncTaskToExternal({ taskId: 'task-1' }, context);

    expect(result.status).toBe('synced');
    expect(result.syncedCount).toBe(1);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      system: 'quickbooks',
      entity: 'task',
      localId: 'task-1',
      externalId: 'ta-1'
    }));
  });

  it('imports webhook time-activity updates into Timesheet tasks', async () => {
    const createTask = jest.fn().mockResolvedValue({ id: 'task-created' });
    const upsert = jest.fn();

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
        refreshToken: jest.fn().mockResolvedValue('token-2'),
        getConnectionInfo: jest.fn().mockResolvedValue({ connected: true, provider: 'quickbooks', accountId: 'realm-1' })
      },
      mappings: {
        list: jest
          .fn()
          .mockResolvedValueOnce([{ localId: 'project-1', externalId: 'customer-1', syncStatus: 'SYNCED' }])
          .mockResolvedValueOnce([{ localId: 'user-1', externalId: 'employee-1', syncStatus: 'SYNCED' }]),
        findByExternal: jest.fn().mockResolvedValue(null),
        upsert,
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

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { forEach: () => {} },
      json: async () => ({
        QueryResponse: {
          TimeActivity: [
            {
              Id: 'ta-1',
              Description: 'Imported from QB',
              CustomerRef: { value: 'customer-1' },
              EmployeeRef: { value: 'employee-1' },
              StartTime: '2026-02-20T10:00:00Z',
              EndTime: '2026-02-20T11:00:00Z',
              BillableStatus: 'Billable',
              MetaData: { LastUpdatedTime: '2026-02-20T12:00:00Z' }
            }
          ]
        }
      }),
      text: async () => '{}'
    });

    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as typeof fetch;

    const result = await handleWebhook({
      body: {
        eventNotifications: [
          {
            dataChangeEvent: {
              entities: [{ name: 'TimeActivity', id: 'ta-1' }]
            }
          }
        ]
      }
    }, context);

    expect(result.syncedCount).toBe(1);
    expect(createTask).toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      entity: 'task',
      externalId: 'ta-1'
    }));
  });
});
