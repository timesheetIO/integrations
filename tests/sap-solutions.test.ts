import type { AbsenceDto, AbsenceTypeDto, IntegrationContext, Member, PauseDto, TagDto, TaskDto } from '@timesheet/integration-sdk';
import { buildExport } from '../sap-solutions/src/handlers/buildExport';
import { buildMonthly } from '../sap-solutions/src/handlers/buildMonthly';
import { listAbsenceTypes } from '../sap-solutions/src/handlers/listAbsenceTypes';
import { listHistory } from '../sap-solutions/src/handlers/listHistory';
import { listTags } from '../sap-solutions/src/handlers/listTags';
import { parseInstant, splitByDay, taskWindow, to12h } from '../sap-solutions/src/lib/time';
import type { SapConfig } from '../sap-solutions/src/lib/types';

type Mapping = { entity: string; localId: string; externalId: string };

interface Fixture {
  tasks?: TaskDto[];
  absences?: AbsenceDto[];
  absenceTypes?: AbsenceTypeDto[];
  colleagues?: Member[];
  tags?: TagDto[];
  mappings?: Mapping[];
  config?: SapConfig;
  organizationId?: string | null;
  userId?: string;
}

interface Harness {
  context: IntegrationContext<SapConfig>;
  writes: Array<{ filename: string; contentType: string; content: string }>;
  calls: Record<string, Array<Record<string, unknown> | undefined>>;
}

function decode(content: string, charset: 'latin1' | 'utf8' = 'utf8'): string {
  return Buffer.from(content, 'base64').toString(charset);
}

function lines(content: string, charset: 'latin1' | 'utf8' = 'utf8'): string[] {
  return decode(content, charset).split('\r\n').filter(line => line !== '');
}

function createHarness(fixture: Fixture): Harness {
  const writes: Harness['writes'] = [];
  const state = new Map<string, unknown>();
  const calls: Harness['calls'] = {};
  const record = (name: string, params?: Record<string, unknown>) => {
    (calls[name] ??= []).push(params);
  };
  const paged = <T>(items: T[]) => (params?: Record<string, unknown>) => {
    const limit = (params?.limit as number) ?? 100;
    const page = (params?.page as number) ?? 1;
    const offset = limit < 0 ? 0 : (page - 1) * limit;
    const slice = limit < 0 ? items : items.slice(offset, offset + limit);
    return Promise.resolve({ items: slice, params: params ?? {} });
  };
  const context = {
    userId: fixture.userId ?? 'user-admin',
    installationId: 'installation-1',
    organizationId: fixture.organizationId === undefined ? 'org-1' : fixture.organizationId ?? undefined,
    config: fixture.config ?? {},
    data: {
      listTasks: (params?: Record<string, unknown>) => {
        record('listTasks', params);
        return paged(fixture.tasks ?? [])(params).then(r => ({ ...r, taskStatistic: {} }));
      },
      getColleagues: (params?: Record<string, unknown>) => {
        record('getColleagues', params);
        return Promise.resolve({ items: fixture.colleagues ?? [], params: params ?? {} });
      },
      listAbsences: (params?: Record<string, unknown>) => {
        record('listAbsences', params);
        return paged(fixture.absences ?? [])(params);
      },
      listAbsenceTypes: (params?: Record<string, unknown>) => {
        record('listAbsenceTypes', params);
        return Promise.resolve({ items: fixture.absenceTypes ?? [], params: {} });
      },
      listTags: (params?: Record<string, unknown>) => {
        record('listTags', params);
        return Promise.resolve({ items: fixture.tags ?? [], params: {} });
      }
    },
    credentials: {},
    mappings: {
      list: async (input: { system: string; entity: string }) =>
        (fixture.mappings ?? [])
          .filter(m => m.entity === input.entity)
          .map(m => ({ localId: m.localId, externalId: m.externalId, syncStatus: 'SYNCED' as const }))
    },
    state: {
      get: async (key: string) => (state.has(key) ? state.get(key) : null),
      set: async (key: string, value: unknown) => {
        state.set(key, value);
      },
      delete: async (key: string) => {
        state.delete(key);
      }
    },
    files: {
      write: async (input: { filename: string; contentType: string; content: string }) => {
        writes.push(input);
        return {
          url: `https://files.example/${input.filename}`,
          filename: input.filename,
          contentType: input.contentType,
          bytes: Buffer.from(input.content, 'base64').length
        };
      }
    },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  } as unknown as IntegrationContext<SapConfig>;
  return { context, writes, calls };
}

function member(uid: string, name: string, employeeId?: string): Member {
  return { uid, email: `${uid}@example.com`, deleted: false, displayName: name, initials: name.slice(0, 2), employeeId };
}

function tag(id: string, name: string, extra: Partial<TagDto> = {}): TagDto {
  return { id, user: 'user-admin', name, archived: false, deleted: false, lastUpdate: 0, created: 0, ...extra };
}

function pause(start: string, end: string): PauseDto {
  return { id: `p-${start}`, user: 'u', running: false, deleted: false, lastUpdate: 0, created: 0, startDateTime: start, endDateTime: end };
}

const PROJECTS: Record<string, string> = { 'p-1': 'Website relaunch', 'p-2': 'Internal' };

function task(
  id: string,
  uid: string,
  start: string,
  end: string,
  options: { project?: string; tags?: TagDto[]; pauses?: PauseDto[]; description?: string; running?: boolean } = {}
): TaskDto {
  const project = options.project ?? 'p-1';
  return {
    id,
    user: uid,
    running: options.running ?? false,
    paid: false,
    billed: false,
    billable: true,
    duration: Math.round((Date.parse(end) - Date.parse(start)) / 1000),
    durationBreak: 0,
    salaryTotal: '0',
    salaryBreak: '0',
    expensesTotal: '0',
    expensesPaid: '0',
    mileage: '0',
    deleted: false,
    lastUpdate: 0,
    created: 0,
    description: options.description,
    startDateTime: start,
    endDateTime: end,
    project: { id: project, title: PROJECTS[project] ?? project } as TaskDto['project'],
    member: { uid } as Member,
    tags: options.tags ?? [],
    pauses: options.pauses ?? []
  };
}

const PERIOD = { from: '2026-08-01', to: '2026-08-31' };
const DEV = tag('tag-dev', 'Development');
const MEETING = tag('tag-mtg', 'Meeting');
const OVERTIME = tag('tag-ot', 'Overtime');

describe('sap-solutions plugin: CATS file', () => {
  const orgFixture = (config: SapConfig = {}): Fixture => ({
    colleagues: [member('user-1', 'Anna Berger'), member('user-2', 'Chris Dorn', '00001002'), member('user-3', 'Eva Fuchs')],
    tasks: [
      task('t-1', 'user-1', '2026-08-03T08:00:00+02:00', '2026-08-03T12:30:00+02:00', {
        tags: [DEV],
        pauses: [pause('2026-08-03T10:00:00+02:00', '2026-08-03T10:30:00+02:00')],
        description: 'Login page'
      }),
      task('t-2', 'user-1', '2026-08-03T13:00:00+02:00', '2026-08-03T15:00:00+02:00', { tags: [DEV], description: 'Login page' }),
      task('t-3', 'user-1', '2026-08-04T09:00:00+02:00', '2026-08-04T10:30:00+02:00', { project: 'p-2', description: 'Team meeting' }),
      task('t-4', 'user-2', '2026-08-03T09:00:00+02:00', '2026-08-03T10:15:00+02:00', { tags: [MEETING], description: 'Sprint review' }),
      task('t-5', 'user-3', '2026-08-03T09:00:00+02:00', '2026-08-03T10:00:00+02:00'),
      task('t-6', 'user-1', '2026-08-05T09:00:00+02:00', '2026-08-05T10:00:00+02:00', { running: true })
    ],
    mappings: [
      { entity: 'user', localId: 'user-1', externalId: '00001001' },
      { entity: 'project', localId: 'p-1', externalId: 'P-100.01.02' },
      { entity: 'tag', localId: 'tag-dev', externalId: '1410' },
      { entity: 'tag', localId: 'tag-mtg', externalId: '1420' }
    ],
    config: { target: 'cats', companyCode: '1010', defaultActivityType: '1000', ...config }
  });

  it('writes one row per employee, day, cost object and activity type, net of breaks', async () => {
    const harness = createHarness(orgFixture());
    const result = await buildExport(PERIOD, harness.context);

    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0].filename).toBe('CATS_2026-08-01_2026-08-31.csv');
    expect(harness.writes[0].contentType).toBe('text/csv');
    expect(lines(harness.writes[0].content)).toEqual([
      'PersonnelNumber;CompanyCode;TimeSheetDate;RecordedHours;WBSElement;ReceiverCostCenter;InternalOrder;ActivityType;TimeSheetNote',
      '00001001;1010;20260803;6,00;P-100.01.02;;;1410;Login page',
      '00001001;1010;20260804;1,50;;;;1000;Team meeting',
      '00001002;1010;20260803;1,25;P-100.01.02;;;1420;Sprint review'
    ]);
    expect(result.count).toBe(3);
    expect(result.target).toBe('cats');
    expect(result.warnings.map(w => w.code).sort()).toEqual(['cost-object-unmapped', 'employee-unmapped']);
    expect(result.warnings.find(w => w.code === 'employee-unmapped')?.message).toContain('Eva Fuchs');
    expect(result.warnings.find(w => w.code === 'cost-object-unmapped')?.message).toContain('Internal');
  });

  it('asks for the day before the period, with pauses and tags, for every member', async () => {
    const harness = createHarness(orgFixture());
    await buildExport(PERIOD, harness.context);
    const params = harness.calls.listTasks?.[0];
    expect(params).toMatchObject({
      startDate: '2026-07-31',
      endDate: '2026-08-31',
      populatePauses: true,
      populateTags: true,
      userIds: ['user-1', 'user-2', 'user-3']
    });
  });

  it('splits tasks at local midnight and keeps only the days inside the period', async () => {
    const harness = createHarness({
      colleagues: [member('user-1', 'Anna Berger', '00001001')],
      tasks: [
        task('t-a', 'user-1', '2026-07-31T22:00:00+02:00', '2026-08-01T02:00:00+02:00'),
        task('t-b', 'user-1', '2026-08-31T23:00:00+02:00', '2026-09-01T01:00:00+02:00'),
        task('t-c', 'user-1', '2026-08-10T22:00:00+02:00', '2026-08-11T06:00:00+02:00', {
          pauses: [pause('2026-08-11T02:00:00+02:00', '2026-08-11T02:30:00+02:00')]
        })
      ],
      mappings: [{ entity: 'project', localId: 'p-1', externalId: 'P-1' }],
      config: { target: 'cats', defaultActivityType: '1000' }
    });
    const result = await buildExport(PERIOD, harness.context);
    expect(lines(harness.writes[0].content).slice(1)).toEqual([
      '00001001;;20260801;2,00;P-1;;;1000;',
      '00001001;;20260810;2,00;P-1;;;1000;',
      '00001001;;20260811;5,50;P-1;;;1000;',
      '00001001;;20260831;1,00;P-1;;;1000;'
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('writes one row per task, puts the key in the configured column and never cuts keys', async () => {
    const longNote = 'Überarbeitung der Startseite für den Kunden Müller GmbH und weitere Seiten';
    const harness = createHarness({
      colleagues: [member('user-1', 'Anna Berger', '1001')],
      tasks: [
        task('t-1', 'user-1', '2026-08-03T08:00:00+02:00', '2026-08-03T09:00:00+02:00', { description: longNote }),
        task('t-2', 'user-1', '2026-08-03T10:00:00+02:00', '2026-08-03T10:30:00+02:00', { description: 'Abstimmung' })
      ],
      mappings: [{ entity: 'project', localId: 'p-1', externalId: 'CC-4711-LONG-KEY-XYZ' }],
      config: {
        target: 'cats',
        aggregation: 'task',
        costObjectType: 'costCenter',
        charset: 'windows-1252',
        separator: 'tab',
        decimalMark: '.',
        dateFormat: 'DD.MM.YYYY',
        headerRow: false
      }
    });
    await buildExport(PERIOD, harness.context);
    expect(lines(harness.writes[0].content, 'latin1')).toEqual([
      `1001\t\t03.08.2026\t1.00\t\tCC-4711-LONG-KEY-XYZ\t\t\t${longNote.slice(0, 40)}`,
      '1001\t\t03.08.2026\t0.50\t\tCC-4711-LONG-KEY-XYZ\t\t\tAbstimmung'
    ]);
  });

  it('reports tasks whose tags map to different activity types', async () => {
    const harness = createHarness({
      ...orgFixture(),
      tasks: [task('t-1', 'user-1', '2026-08-03T08:00:00+02:00', '2026-08-03T09:00:00+02:00', { tags: [DEV, MEETING] })]
    });
    const result = await buildExport(PERIOD, harness.context);
    expect(lines(harness.writes[0].content)[1]).toBe('00001001;1010;20260803;1,00;P-100.01.02;;;1410;');
    expect(result.warnings.map(w => w.code)).toEqual(['tag-conflict']);
  });
});

describe('sap-solutions plugin: personal profile', () => {
  const profileFixture = (config: SapConfig): Fixture => ({
    organizationId: null,
    userId: 'user-1',
    tasks: [
      task('t-1', 'user-1', '2026-08-03T08:00:00+02:00', '2026-08-03T10:00:00+02:00'),
      task('t-9', 'user-9', '2026-08-03T08:00:00+02:00', '2026-08-03T10:00:00+02:00')
    ],
    mappings: [{ entity: 'project', localId: 'p-1', externalId: 'P-1' }],
    config
  });

  it('exports only the installing user with the personnel number from the settings', async () => {
    const harness = createHarness(profileFixture({ target: 'cats', personnelNumber: '4711', defaultActivityType: '1000' }));
    const result = await buildExport(PERIOD, harness.context);
    expect(lines(harness.writes[0].content).slice(1)).toEqual(['4711;;20260803;2,00;P-1;;;1000;']);
    expect(harness.calls.getColleagues).toBeUndefined();
    expect(harness.calls.listTasks?.[0]?.userIds).toEqual(['user-1']);
    expect(result.warnings).toEqual([]);
  });

  it('asks for the personnel number when none is set', async () => {
    const harness = createHarness(profileFixture({ target: 'cats' }));
    await expect(buildExport(PERIOD, harness.context)).rejects.toThrow(/personnel number/);
    expect(harness.writes).toHaveLength(0);
  });

  it('refuses the SuccessFactors target outside an organization', async () => {
    const harness = createHarness(profileFixture({ target: 'successfactors', personnelNumber: '4711' }));
    await expect(buildExport(PERIOD, harness.context)).rejects.toThrow(/organization installation/);
  });

  it('offers no absence types on a profile', async () => {
    const harness = createHarness({ organizationId: null, absenceTypes: [{ id: 'vac', name: 'Vacation' } as AbsenceTypeDto] });
    expect(await listAbsenceTypes(undefined, harness.context)).toEqual({ items: [] });
    expect(harness.calls.listAbsenceTypes).toBeUndefined();
  });
});

describe('sap-solutions plugin: SuccessFactors files', () => {
  const sfFixture = (config: SapConfig, extra: Partial<Fixture> = {}): Fixture => ({
    colleagues: [member('user-1', 'Anna Berger'), member('user-2', 'Chris Dorn', 'cdorn')],
    tasks: [
      task('t-1', 'user-1', '2026-08-03T08:00:00+02:00', '2026-08-03T12:30:00+02:00', {
        pauses: [pause('2026-08-03T10:00:00+02:00', '2026-08-03T10:30:00+02:00')]
      }),
      task('t-2', 'user-1', '2026-08-03T13:00:00+02:00', '2026-08-03T15:00:00+02:00'),
      task('t-3', 'user-1', '2026-08-03T18:00:00+02:00', '2026-08-03T19:00:00+02:00', { tags: [OVERTIME] }),
      task('t-4', 'user-2', '2026-08-04T09:00:00+02:00', '2026-08-04T10:15:00+02:00')
    ],
    mappings: [
      { entity: 'user', localId: 'user-1', externalId: 'anna.berger' },
      { entity: 'tag', localId: 'tag-ot', externalId: 'OVERTIME_T' },
      { entity: 'absence_type', localId: 'vac', externalId: 'TT_VACATION' }
    ],
    config: { target: 'successfactors', ...config },
    ...extra
  });

  it('writes External Time Data with hours per user, day and time type', async () => {
    const harness = createHarness(sfFixture({}));
    const result = await buildExport(PERIOD, harness.context);
    expect(harness.writes.map(w => w.filename)).toEqual(['ExternalTimeData_2026-08-01_2026-08-31.csv']);
    expect(lines(harness.writes[0].content)).toEqual([
      'userId,startDate,endDate,startTime,endTime,hours,timeType,category',
      'anna.berger,08/03/2026,,,,6.00,,Attendance',
      'anna.berger,08/03/2026,,,,1.00,OVERTIME_T,',
      'cdorn,08/04/2026,,,,1.25,,Attendance'
    ]);
    expect(result.count).toBe(3);
    expect(result.warnings).toEqual([]);
  });

  it('writes clock times with Break rows and an endDate past midnight', async () => {
    const harness = createHarness(
      sfFixture(
        { timeMode: 'clock', clockFormat: '12h', defaultTimeType: 'ATT_EXT' },
        {
          tasks: [
            task('t-1', 'user-1', '2026-08-03T08:00:00+02:00', '2026-08-03T12:30:00+02:00', {
              pauses: [pause('2026-08-03T10:00:00+02:00', '2026-08-03T10:30:00+02:00')]
            }),
            task('t-2', 'user-1', '2026-08-05T22:00:00+02:00', '2026-08-06T05:00:00+02:00'),
            task('t-0', 'user-1', '2026-07-31T22:00:00+02:00', '2026-08-01T02:00:00+02:00')
          ]
        }
      )
    );
    const result = await buildExport(PERIOD, harness.context);
    expect(lines(harness.writes[0].content).slice(1)).toEqual([
      'anna.berger,08/03/2026,,08:00:00 am,12:30:00 pm,,ATT_EXT,',
      'anna.berger,08/03/2026,,10:00:00 am,10:30:00 am,,,Break',
      'anna.berger,08/05/2026,08/06/2026,10:00:00 pm,05:00:00 am,,ATT_EXT,'
    ]);
    expect(result.warnings.map(w => w.code)).toEqual(['cross-midnight']);
  });

  it('adds Employee Time with approved absences that start in the period', async () => {
    const absence = (id: string, uid: string, type: string, start: string, end: string, extra: Partial<AbsenceDto> = {}): AbsenceDto => ({
      id,
      member: member(uid, uid === 'user-1' ? 'Anna Berger' : 'Chris Dorn', uid === 'user-2' ? 'cdorn' : undefined),
      absenceTypeId: type,
      startDateTime: `${start}T00:00:00`,
      endDateTime: `${end}T23:59:59`,
      fullDay: true,
      status: 'approved',
      ...extra
    });
    const harness = createHarness(
      sfFixture(
        { includeAbsences: true },
        {
          tasks: [],
          absenceTypes: [{ id: 'vac', name: 'Vacation' } as AbsenceTypeDto, { id: 'sick', name: 'Sick leave' } as AbsenceTypeDto],
          absences: [
            absence('a-1', 'user-1', 'vac', '2026-08-10', '2026-08-14'),
            absence('a-2', 'user-1', 'vac', '2026-08-20', '2026-08-20', { fullDay: false, totalHours: '3.5' }),
            absence('a-3', 'user-2', 'sick', '2026-08-11', '2026-08-12'),
            absence('a-4', 'user-1', 'vac', '2026-07-30', '2026-08-03'),
            absence('a-5', 'user-1', 'vac', '2026-08-25', '2026-08-26', { status: 'pending' })
          ]
        }
      )
    );
    const result = await buildExport(PERIOD, harness.context);
    expect(harness.writes.map(w => w.filename)).toEqual([
      'ExternalTimeData_2026-08-01_2026-08-31.csv',
      'EmployeeTime_2026-08-01_2026-08-31.csv'
    ]);
    expect(lines(harness.writes[0].content)).toEqual(['userId,startDate,endDate,startTime,endTime,hours,timeType,category']);
    expect(lines(harness.writes[1].content)).toEqual([
      'externalCode,userId,timeType,startDate,endDate,approvalStatus,fractionQuantity',
      'timesheet-a-1,anna.berger,TT_VACATION,08/10/2026,08/14/2026,APPROVED,',
      'timesheet-a-2,anna.berger,TT_VACATION,08/20/2026,08/20/2026,APPROVED,3.5'
    ]);
    expect(result.count).toBe(2);
    expect(result.warnings.map(w => w.code)).toEqual(['absence-type-unmapped']);
    expect(result.warnings[0].message).toContain('Sick leave');
    expect(harness.calls.listAbsences?.[0]).toMatchObject({ startDate: '2026-08-01', endDate: '2026-08-31', statuses: ['approved'] });
  });

  it('leaves absences out unless switched on', async () => {
    const harness = createHarness(sfFixture({}));
    await buildExport(PERIOD, harness.context);
    expect(harness.calls.listAbsences).toBeUndefined();
    expect(harness.writes).toHaveLength(1);
  });
});

describe('sap-solutions plugin: monthly run, history and lists', () => {
  it('exports the previous month and keeps the last twelve runs', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-14T06:00:00Z'));
    try {
      const harness = createHarness({
        colleagues: [member('user-1', 'Anna Berger', '1001')],
        tasks: [task('t-1', 'user-1', '2026-08-03T08:00:00+02:00', '2026-08-03T09:00:00+02:00')],
        mappings: [{ entity: 'project', localId: 'p-1', externalId: 'P-1' }],
        config: { target: 'cats' }
      });
      const result = await buildMonthly(undefined, harness.context);
      expect(result.period).toEqual(PERIOD);
      expect(result.count).toBe(1);

      for (let i = 0; i < 12; i++) {
        await buildExport(PERIOD, harness.context);
      }
      const history = await listHistory(undefined, harness.context);
      expect(history.items).toHaveLength(12);
      expect(history.items[0]).toMatchObject({
        target: 'CATS',
        period: '2026-08-01 to 2026-08-31',
        files: 'CATS_2026-08-01_2026-08-31.csv',
        count: 1,
        warnings: 0
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('lists active tags sorted by name for the mapping', async () => {
    const harness = createHarness({
      tags: [MEETING, DEV, tag('tag-old', 'Archived', { archived: true }), tag('tag-del', 'Deleted', { deleted: true })]
    });
    expect(await listTags(undefined, harness.context)).toEqual({
      items: [
        { id: 'tag-dev', name: 'Development' },
        { id: 'tag-mtg', name: 'Meeting' }
      ]
    });
    expect(harness.calls.listTags?.[0]).toEqual({ limit: -1 });
  });
});

describe('sap-solutions plugin: time helpers', () => {
  it('reads offsets, Z and strings without an offset', () => {
    expect(parseInstant('2026-08-03T22:00:00+02:00')?.epoch).toBe(Date.parse('2026-08-03T20:00:00Z'));
    expect(parseInstant('2026-08-03T22:00:00.000Z')).toEqual({ epoch: Date.parse('2026-08-03T22:00:00Z'), offsetMinutes: 0 });
    expect(parseInstant('2026-08-03T22:00:00-0530')?.offsetMinutes).toBe(-330);
    expect(parseInstant('2026-08-03')).toBeNull();
  });

  it('spreads the break over the days when break times are missing', () => {
    const t = task('t-1', 'user-1', '2026-08-10T22:00:00+02:00', '2026-08-11T02:00:00+02:00');
    const window = taskWindow({ ...t, pauses: undefined, durationBreak: 3600 });
    expect(window && splitByDay(window)).toEqual([
      { date: '2026-08-10', netSeconds: 5400 },
      { date: '2026-08-11', netSeconds: 5400 }
    ]);
  });

  it('skips running tasks and tasks without a start', () => {
    expect(taskWindow(task('t-1', 'user-1', '2026-08-10T08:00:00+02:00', '2026-08-10T09:00:00+02:00', { running: true }))).toBeNull();
    expect(taskWindow({ ...task('t-2', 'user-1', '2026-08-10T08:00:00+02:00', '2026-08-10T09:00:00+02:00'), startDateTime: undefined })).toBeNull();
  });

  it('formats the 12-hour clock around midnight and noon', () => {
    expect(to12h('00:30:00')).toBe('12:30:00 am');
    expect(to12h('12:00:00')).toBe('12:00:00 pm');
    expect(to12h('23:59:59')).toBe('11:59:59 pm');
  });
});
