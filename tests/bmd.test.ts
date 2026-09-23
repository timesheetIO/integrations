import type {
  AbsenceDto,
  AbsenceTypeDto,
  DocumentDto,
  ExpenseDto,
  IntegrationContext,
  Member,
  OvertimeBalanceDto,
  TaskDto
} from '@timesheet/integration-sdk';
import { buildFibu } from '../bmd/src/handlers/buildFibu';
import { buildLohn } from '../bmd/src/handlers/buildLohn';
import { buildMonthly } from '../bmd/src/handlers/buildMonthly';
import { listCustomers } from '../bmd/src/handlers/listCustomers';
import { listHistory } from '../bmd/src/handlers/listHistory';
import { listSurchargeTypes } from '../bmd/src/handlers/listSurchargeTypes';
import type { BmdConfig } from '../bmd/src/lib/types';
import { encodeSingleByte, toScaled } from '../bmd/src/lib/writer';

type Mapping = { entity: string; localId: string; externalId: string };

interface Fixture {
  documents?: DocumentDto[];
  tasks?: TaskDto[];
  balances?: OvertimeBalanceDto[];
  absences?: AbsenceDto[];
  expenses?: ExpenseDto[];
  colleagues?: Member[];
  absenceTypes?: AbsenceTypeDto[];
  mappings?: Mapping[];
  config?: BmdConfig;
  organizationId?: string | null;
}

interface Harness {
  context: IntegrationContext<BmdConfig>;
  writes: Array<{ filename: string; contentType: string; content: string }>;
  state: Map<string, unknown>;
  calls: Record<string, unknown[]>;
}

function decode(content: string, charset: 'latin1' | 'utf8' = 'latin1'): string {
  return Buffer.from(content, 'base64').toString(charset);
}

function createHarness(fixture: Fixture): Harness {
  const writes: Harness['writes'] = [];
  const state = new Map<string, unknown>();
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, params: unknown) => {
    (calls[name] ??= []).push(params);
  };
  const paged = <T>(items: T[]) => (params?: { page?: number; limit?: number }) => {
    const limit = params?.limit ?? 100;
    const page = params?.page ?? 1;
    const offset = page <= 0 ? 0 : (page - 1) * limit;
    return Promise.resolve({ items: items.slice(offset, offset + limit), params: params ?? {} });
  };
  const documents = fixture.documents ?? [];
  const context = {
    userId: 'user-admin',
    installationId: 'installation-1',
    organizationId: fixture.organizationId === undefined ? 'org-1' : fixture.organizationId ?? undefined,
    config: fixture.config ?? { firmennummer: '7' },
    data: {
      listDocuments: (params?: Record<string, unknown>) => {
        record('listDocuments', params);
        return paged(documents)(params);
      },
      listTasks: (params?: Record<string, unknown>) => {
        record('listTasks', params);
        return paged(fixture.tasks ?? [])(params).then(r => ({ ...r, taskStatistic: {} }));
      },
      listOvertimeBalances: (params?: Record<string, unknown>) => {
        record('listOvertimeBalances', params);
        const list = fixture.balances ?? [];
        // organization endpoint counts pages from 0
        const limit = (params?.limit as number) ?? 100;
        const page = (params?.page as number) ?? 0;
        return Promise.resolve({ items: list.slice(page * limit, page * limit + limit), params: params ?? {} });
      },
      listAbsences: (params?: Record<string, unknown>) => {
        record('listAbsences', params);
        return paged(fixture.absences ?? [])(params);
      },
      listExpenses: (params?: Record<string, unknown>) => {
        record('listExpenses', params);
        return paged(fixture.expenses ?? [])(params);
      },
      getColleagues: (params?: Record<string, unknown>) => {
        record('getColleagues', params);
        return Promise.resolve({ items: fixture.colleagues ?? [], params: params ?? {} });
      },
      listAbsenceTypes: () => Promise.resolve({ items: fixture.absenceTypes ?? [], params: {} })
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
  } as unknown as IntegrationContext<BmdConfig>;
  return { context, writes, state, calls };
}

function invoice(overrides: Partial<DocumentDto> & { id: string }): DocumentDto {
  return {
    category: 0,
    date: '2026-08-10',
    invoiceId: overrides.id.toUpperCase(),
    customer: 'Muster GmbH',
    customerId: 'K1',
    tax: '20',
    taxValue: '20.00',
    total: '120.00',
    subtotal: '100.00',
    dueDate: '2026-09-09',
    ...overrides
  };
}

const member = (uid: string, displayName: string, employeeId?: string): Member => ({
  uid,
  email: `${uid}@example.com`,
  deleted: false,
  displayName,
  initials: displayName.slice(0, 2).toUpperCase(),
  employeeId
});

const task = (id: string, user: string, seconds: number, breakSeconds = 0, start = '2026-08-05T08:00:00.000Z'): TaskDto => ({
  id,
  user,
  running: false,
  paid: false,
  billed: false,
  billable: true,
  duration: seconds,
  durationBreak: breakSeconds,
  salaryTotal: '0',
  salaryBreak: '0',
  expensesTotal: '0',
  expensesPaid: '0',
  mileage: '0',
  deleted: false,
  lastUpdate: 0,
  created: 0,
  startDateTime: start,
  member: member(user, user)
});

describe('bmd plugin: FIBU Buchungsimport', () => {
  const period = { from: '2026-08-01', to: '2026-08-31' };

  it('writes one line per invoice and tax rate with mapped and fallback debtors', async () => {
    const harness = createHarness({
      documents: [
        invoice({ id: 'r-1', customer: 'Müller & Söhne GmbH', customerId: 'K1' }),
        invoice({ id: 'g-1', invoiceTypeCode: '381', customer: 'Muster GmbH', customerId: 'K1', total: '60.00', taxValue: '10.00', subtotal: '50.00', date: '2026-08-12' }),
        invoice({ id: 'r-2', customer: 'EU Partner BV', customerId: 'K2', isReverseCharge: true, tax: '0', taxValue: '0', total: '100.00', subtotal: '100.00', date: '2026-08-15' }),
        invoice({
          id: 'r-3',
          customer: 'Zwei Sätze AG',
          customerId: 'K3',
          subtotal: '300.00',
          tax: '20',
          taxValue: '40.00',
          taxSecond: '10',
          taxSecondValue: '10.00',
          showSecondTax: true,
          total: '350.00',
          date: '2026-08-20',
          costCenter: 'KST9'
        }),
        invoice({ id: 'r-4', customer: 'Neu AG', customerId: '', date: '2026-08-28', dueDate: undefined })
      ],
      mappings: [
        { entity: 'customer', localId: 'K1', externalId: '20001' },
        { entity: 'customer', localId: 'K2', externalId: '20002' },
        { entity: 'customer', localId: 'K3', externalId: '20003' }
      ],
      config: { firmennummer: '7', filiale: '1' }
    });

    const result = await buildFibu(period, harness.context);

    expect(result.count).toBe(5);
    expect(result.files).toHaveLength(1);
    expect(harness.writes[0].filename).toBe('BMD_FIBU_2026-08-01_2026-08-31.csv');
    expect(harness.writes[0].contentType).toBe('text/csv');

    const text = decode(harness.writes[0].content);
    const expected = [
      'satzart;konto;gkonto;belegnr;belegdatum;buchdatum;buchsymbol;buchcode;prozent;steuercode;betrag;steuer;text;extbelegnr;faelligkeit;kost;filiale',
      '0;20001;4000;R-1;10.08.2026;10.08.2026;AR;1;20,00;1;120,00;20,00;Müller & Söhne GmbH R-1;;09.09.2026;;1',
      '0;20001;4000;G-1;12.08.2026;12.08.2026;AR;2;20,00;1;60,00;10,00;Muster GmbH G-1;;09.09.2026;;1',
      '0;20002;4020;R-2;15.08.2026;15.08.2026;AR;1;0,00;22;100,00;0,00;EU Partner BV R-2;;09.09.2026;;1',
      '0;20003;4000;R-3;20.08.2026;20.08.2026;AR;1;20,00;1;240,00;40,00;Zwei Sätze AG R-3;;09.09.2026;KST9;1',
      '0;20003;4001;R-3;20.08.2026;20.08.2026;AR;1;10,00;2;110,00;10,00;Zwei Sätze AG R-3;;09.09.2026;KST9;1',
      '0;20000;4000;R-4;28.08.2026;28.08.2026;AR;1;20,00;1;120,00;20,00;Neu AG R-4;;;;1',
      ''
    ].join('\r\n');
    expect(text).toBe(expected);

    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'debtor-unmapped', details: expect.objectContaining({ customer: 'Neu AG', invoiceId: 'R-4' }) })
    ]);

    // Windows-1252: ü is a single byte 0xFC
    const bytes = Buffer.from(harness.writes[0].content, 'base64');
    expect(bytes.includes(Buffer.from([0xfc]))).toBe(true);
    expect(bytes.includes(Buffer.from('Ã¼', 'latin1'))).toBe(false);

    const history = await listHistory(undefined, harness.context);
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toEqual(expect.objectContaining({ surface: 'fibu', count: 5, warningCount: 1, from: '2026-08-01', to: '2026-08-31' }));
    expect(harness.calls.listDocuments[0]).toEqual(expect.objectContaining({ organizationId: 'org-1', category: 0, startDate: '2026-08-01', endDate: '2026-08-31' }));
  });

  it('writes credit notes as negative amounts in negativ mode', async () => {
    const harness = createHarness({
      documents: [invoice({ id: 'g-2', eInvoiceDocumentType: 'CREDIT_NOTE', total: '-120.00', taxValue: '-20.00' })],
      mappings: [{ entity: 'customer', localId: 'K1', externalId: '20001' }],
      config: { firmennummer: '7', gutschriftModus: 'negativ', headerRow: false }
    });
    await buildFibu(period, harness.context);
    expect(decode(harness.writes[0].content)).toBe('0;20001;4000;G-2;10.08.2026;10.08.2026;AR;1;20,00;1;-120,00;-20,00;Muster GmbH G-2;;09.09.2026;;\r\n');
  });

  it('rejects an invoice dated outside the period', async () => {
    const harness = createHarness({ documents: [invoice({ id: 'r-9', date: '2026-09-01' })] });
    await expect(buildFibu(period, harness.context)).rejects.toThrow('außerhalb des Zeitraums');
    expect(harness.writes).toHaveLength(0);
  });

  it('skips a second tax rate it cannot split and reports it', async () => {
    const harness = createHarness({
      documents: [
        invoice({ id: 'r-5', taxSecond: '0', taxSecondValue: '5.00', showSecondTax: true, total: '125.00' }),
        invoice({ id: 'r-6', tax: '19', taxValue: '19.00', total: '119.00' })
      ],
      mappings: [{ entity: 'customer', localId: 'K1', externalId: '20001' }],
      config: { firmennummer: '7', headerRow: false }
    });
    const result = await buildFibu(period, harness.context);
    expect(result.count).toBe(0);
    expect(decode(harness.writes[0].content)).toBe('');
    expect(result.warnings.map(w => w.code)).toEqual(['second-tax-unsplittable', 'tax-rate-unconfigured']);
  });

  it('honours separator, decimal mark, date format, quoting and utf-8 charset', async () => {
    const harness = createHarness({
      documents: [invoice({ id: 'r-7', customer: 'Größe; AG', customerId: 'K1' })],
      mappings: [{ entity: 'customer', localId: 'K1', externalId: '20001' }],
      config: {
        firmennummer: '7',
        separator: '|',
        decimalMark: '.',
        dateFormat: 'YYYYMMDD',
        charset: 'utf-8',
        quoteText: true,
        headerRow: false
      }
    });
    await buildFibu(period, harness.context);
    expect(decode(harness.writes[0].content, 'utf8')).toBe('0|20001|4000|"R-7"|20260810|20260810|AR|1|20.00|1|120.00|20.00|"Größe; AG R-7"|""|20260909|""|""\r\n');
  });

  it('requires an organization installation', async () => {
    const harness = createHarness({ organizationId: null });
    await expect(buildFibu(period, harness.context)).rejects.toThrow('Organisation');
  });

  it('lists distinct customers from invoices for the debtor mapping', async () => {
    const harness = createHarness({
      documents: [
        invoice({ id: 'r-1', customer: 'Muster GmbH', customerId: 'K1' }),
        invoice({ id: 'r-2', customer: 'Muster G.m.b.H.', customerId: 'K1' }),
        invoice({ id: 'r-3', customer: 'Alpha OG', customerId: '' }),
        invoice({ id: 'r-4', customer: '', customerId: 'K7' })
      ]
    });
    const result = await listCustomers(undefined, harness.context);
    expect(result.items).toEqual([
      { id: 'Alpha OG', name: 'Alpha OG' },
      { id: 'K7', name: 'K7' },
      { id: 'K1', name: 'Muster GmbH (K1)' }
    ]);
  });
});

describe('bmd plugin: Lohn import', () => {
  const period = { from: '2026-08-01', to: '2026-08-31' };

  const fixture = (): Fixture => ({
    colleagues: [member('user-1', 'Anna Berger'), member('user-2', 'Chris Dorn', '200'), member('user-3', 'Eva Fuchs')],
    tasks: [
      task('t-1', 'user-1', 7200, 600),
      task('t-2', 'user-1', 3600),
      task('t-3', 'user-2', 3600),
      task('t-4', 'user-3', 3600),
      task('t-5', 'user-1', 3600, 0, '2026-09-01T08:00:00.000Z')
    ],
    balances: [
      {
        id: 'b-1',
        member: member('user-1', 'Anna Berger'),
        periodStart: '2026-08-01',
        periodEnd: '2026-08-31',
        overtimeMinutes: 120,
        overtimeTier1Minutes: 90,
        overtimeTier2Minutes: 30,
        nightMinutes: 60
      },
      {
        id: 'b-2',
        member: member('user-2', 'Chris Dorn', '200'),
        periodStart: '2026-08-01',
        periodEnd: '2026-08-31',
        overtimeMinutes: 45
      }
    ],
    absences: [
      {
        id: 'a-1',
        member: member('user-1', 'Anna Berger'),
        absenceTypeId: 'sick',
        startDateTime: '2026-08-03T00:00:00.000Z',
        endDateTime: '2026-08-04T23:59:59.000Z',
        fullDay: true,
        totalDays: '2',
        status: 'approved'
      },
      {
        id: 'a-2',
        member: member('user-2', 'Chris Dorn', '200'),
        absenceTypeId: 'vac',
        startDateTime: '2026-08-10T00:00:00.000Z',
        endDateTime: '2026-08-14T23:59:59.000Z',
        fullDay: true,
        totalDays: '5',
        status: 'approved'
      },
      {
        id: 'a-3',
        member: member('user-2', 'Chris Dorn', '200'),
        absenceTypeId: 'sick',
        startDateTime: '2026-08-30T00:00:00.000Z',
        endDateTime: '2026-09-02T23:59:59.000Z',
        fullDay: true,
        totalDays: '4',
        status: 'approved'
      }
    ],
    expenses: [
      { id: 'e-1', user: 'user-1', amount: '26.40', refunded: false, deleted: false, lastUpdate: 0, created: 0, description: 'Taggeld Wien', dateTime: '2026-08-06T00:00:00.000Z' },
      { id: 'e-2', user: 'user-1', amount: '15.00', refunded: false, deleted: false, lastUpdate: 0, created: 0, description: 'Parken', dateTime: '2026-08-06T00:00:00.000Z' }
    ],
    absenceTypes: [
      { id: 'sick', name: 'Krankenstand' },
      { id: 'vac', name: 'Urlaub' }
    ],
    mappings: [
      { entity: 'user', localId: 'user-1', externalId: '100' },
      { entity: 'absence_type', localId: 'sick', externalId: 'KR' },
      { entity: 'surcharge_type', localId: 'normalstunden', externalId: '1000' },
      { entity: 'surcharge_type', localId: 'ueberstunden-50', externalId: '1050' },
      { entity: 'surcharge_type', localId: 'ueberstunden-100', externalId: '1100' },
      { entity: 'surcharge_type', localId: 'nachtarbeit', externalId: '1300' },
      { entity: 'surcharge_type', localId: 'taggeld', externalId: '1700' }
    ],
    config: { firmennummer: '7', taggeldKeyword: 'Taggeld' }
  });

  it('writes worked time, overtime tiers, absences and allowances per employee', async () => {
    const harness = createHarness(fixture());
    const result = await buildLohn(period, harness.context);

    expect(harness.writes[0].filename).toBe('BMD_LOHN_2026-08-01_2026-08-31.csv');
    const text = decode(harness.writes[0].content);
    const expected = [
      'firmennr;dienstverhaeltnisnr;lohnart;datum_von;datum_bis;stunden;tage;betrag;text',
      '7;100;1000;01.08.2026;31.08.2026;2,83;;;Normalstunden',
      '7;100;1050;01.08.2026;31.08.2026;1,50;;;Überstunden 50 %',
      '7;100;1100;01.08.2026;31.08.2026;0,50;;;Überstunden 100 %',
      '7;100;1300;01.08.2026;31.08.2026;1,00;;;Nachtarbeit',
      '7;100;1700;01.08.2026;31.08.2026;;;26,40;Taggeld',
      '7;100;KR;03.08.2026;04.08.2026;;2,00;;Krankenstand',
      '7;200;1000;01.08.2026;31.08.2026;1,00;;;Normalstunden',
      '7;200;1050;01.08.2026;31.08.2026;0,75;;;Überstunden 50 %',
      '7;200;KR;30.08.2026;31.08.2026;;2,00;;Krankenstand',
      ''
    ].join('\r\n');
    expect(text).toBe(expected);
    expect(result.count).toBe(9);

    const codes = result.warnings.map(w => w.code).sort();
    expect(codes).toEqual(['absence-clamped', 'employee-unmapped', 'lohnart-unmapped']);
    expect(result.warnings.find(w => w.code === 'employee-unmapped')?.message).toContain('Eva Fuchs');
    expect(result.warnings.find(w => w.code === 'lohnart-unmapped')?.message).toContain('Urlaub');

    expect(harness.calls.listAbsences[0]).toEqual(expect.objectContaining({ startDate: '2026-08-01', endDate: '2026-08-31', statuses: ['approved'] }));
    expect(harness.calls.listTasks[0]).toEqual(expect.objectContaining({ userIds: ['user-1', 'user-2', 'user-3'] }));
    expect(harness.calls.listOvertimeBalances[0]).toEqual(expect.objectContaining({ page: 0 }));

    const history = await listHistory(undefined, harness.context);
    expect(history.items[0]).toEqual(expect.objectContaining({ surface: 'lohn', count: 9 }));
  });

  it('skips expenses entirely when no keyword is configured', async () => {
    const f = fixture();
    f.config = { firmennummer: '7' };
    const harness = createHarness(f);
    await buildLohn(period, harness.context);
    expect(harness.calls.listExpenses).toBeUndefined();
    expect(decode(harness.writes[0].content)).not.toContain('Taggeld');
  });

  it('offers the fixed surcharge list for the mapping', async () => {
    const harness = createHarness({});
    const result = await listSurchargeTypes(undefined, harness.context);
    expect(result.items.map(i => i.id)).toEqual([
      'normalstunden',
      'ueberstunden-50',
      'ueberstunden-100',
      'nachtarbeit',
      'sonntagsarbeit',
      'feiertagsarbeit',
      'seg-zulage',
      'taggeld',
      'naechtigungsgeld'
    ]);
  });
});

describe('bmd plugin: monthly run', () => {
  it('exports the previous month on both surfaces and keeps the last twelve runs', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-14T06:00:00Z'));
    try {
      const harness = createHarness({
        documents: [invoice({ id: 'r-1' })],
        mappings: [{ entity: 'customer', localId: 'K1', externalId: '20001' }],
        colleagues: [member('user-1', 'Anna Berger', '100')],
        config: { firmennummer: '7' }
      });
      const result = await buildMonthly(undefined, harness.context);
      expect(result.period).toEqual({ from: '2026-08-01', to: '2026-08-31' });
      expect(result.fibu?.count).toBe(1);
      expect(result.lohn?.count).toBe(0);
      expect(result.skipped).toEqual([]);
      expect(harness.writes.map(w => w.filename)).toEqual(['BMD_FIBU_2026-08-01_2026-08-31.csv', 'BMD_LOHN_2026-08-01_2026-08-31.csv']);

      for (let i = 0; i < 12; i++) {
        await buildFibu({ from: '2026-08-01', to: '2026-08-31' }, harness.context);
      }
      const history = await listHistory(undefined, harness.context);
      expect(history.items).toHaveLength(12);
    } finally {
      jest.useRealTimers();
    }
  });

  it('skips surfaces that are switched off', async () => {
    const harness = createHarness({ config: { firmennummer: '7', monthlyFibu: false } });
    const result = await buildMonthly(undefined, harness.context);
    expect(result.fibu).toBeUndefined();
    expect(result.lohn).toBeDefined();
    expect(result.skipped).toEqual(['fibu']);
  });
});

describe('bmd plugin: writer helpers', () => {
  it('rounds half even on strings', () => {
    expect(toScaled('2.345', 2)).toBe('2.34');
    expect(toScaled('2.355', 2)).toBe('2.36');
    expect(toScaled('-0.004', 2)).toBe('0.00');
    expect(toScaled(1.005, 2)).toBe('1.00');
  });

  it('encodes the euro sign and umlauts as single Windows-1252 bytes', () => {
    const bytes = encodeSingleByte('€ Ä ü ß', 'windows-1252');
    expect(Array.from(bytes)).toEqual([0x80, 0x20, 0xc4, 0x20, 0xfc, 0x20, 0xdf]);
    expect(Array.from(encodeSingleByte('€', 'iso-8859-1'))).toEqual([0x3f]);
  });
});
