import type { AbsenceDto, AbsenceTypeDto, DocumentDto, ExpenseDto, IntegrationContext, MappingRecord, Member, OvertimeBalanceDto, TaskDto, WrittenFile } from '@timesheet/integration-sdk';
import { buildBuchungsstapel } from '../datev/src/handlers/buildBuchungsstapel';
import { buildMonthly } from '../datev/src/handlers/buildMonthly';
import { buildPayroll } from '../datev/src/handlers/buildPayroll';
import { listAbsenceTypes } from '../datev/src/handlers/listAbsenceTypes';
import { listCustomers } from '../datev/src/handlers/listCustomers';
import { listHistory } from '../datev/src/handlers/listHistory';
import { EXTF_COLUMNS } from '../datev/src/lib/extf';
import { fiscalYearEnd, fiscalYearStart, parseWjBeginn, resolvePeriod } from '../datev/src/lib/common';
import type { DatevConfig } from '../datev/src/lib/types';
import {
  PeriodGuard,
  addDecimals,
  encodeSingleByte,
  encodeText,
  formatDate,
  monthBounds,
  previousMonth,
  toScaled
} from '../datev/src/lib/writer';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface Fixture {
  documents?: DocumentDto[];
  colleagues?: Member[];
  tasks?: TaskDto[];
  absences?: AbsenceDto[];
  absenceTypes?: AbsenceTypeDto[];
  overtime?: OvertimeBalanceDto[];
  expenses?: ExpenseDto[];
  mappings?: Record<string, MappingRecord[]>;
  config?: DatevConfig;
  organizationId?: string | null;
}

interface Harness {
  context: IntegrationContext<DatevConfig>;
  written: Array<{ filename: string; contentType: string; bytes: Buffer }>;
  state: Map<string, unknown>;
}

const baseConfig: DatevConfig = {
  beraternummer: '1234567',
  mandantennummer: '12345',
  skr: 'SKR03',
  sachkontenlaenge: 4,
  wirtschaftsjahrBeginn: '01.01.',
  charset: 'windows-1252',
  festschreibung: false,
  debitorStandard: '10000',
  payrollTarget: 'LODAS',
  lohnartArbeitsstunden: '100',
  lohnartUeberstunden: '200'
};

function paged<T>(items: T[]) {
  return async (params: { page?: number; limit?: number } = {}) => {
    const limit = params.limit ?? 100;
    const page = params.page ?? 1;
    return { items: items.slice((page - 1) * limit, page * limit), params };
  };
}

function createHarness(fixture: Fixture = {}): Harness {
  const written: Harness['written'] = [];
  const state = new Map<string, unknown>();
  const mappings = fixture.mappings ?? {};
  const context = {
    userId: 'admin-1',
    installationId: 'installation-1',
    organizationId: fixture.organizationId === null ? undefined : fixture.organizationId ?? 'org-1',
    config: { ...baseConfig, ...(fixture.config ?? {}) },
    data: {
      listDocuments: jest.fn(paged(fixture.documents ?? [])),
      getColleagues: jest.fn(paged(fixture.colleagues ?? [])),
      listTasks: jest.fn(async (params: { page?: number; limit?: number; userIds?: string[] }) => {
        const filtered = (fixture.tasks ?? []).filter(t => !params.userIds || params.userIds.includes(t.user));
        return paged(filtered)(params);
      }),
      listAbsences: jest.fn(paged(fixture.absences ?? [])),
      listAbsenceTypes: jest.fn(paged(fixture.absenceTypes ?? [])),
      listOvertimeBalances: jest.fn(paged(fixture.overtime ?? [])),
      listExpenses: jest.fn(paged(fixture.expenses ?? []))
    },
    credentials: {},
    mappings: {
      get: async () => null,
      findByExternal: async () => null,
      list: async (input: { entity: string }) => mappings[input.entity] ?? [],
      upsert: async () => {},
      delete: async () => {}
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
      write: async (input: { filename: string; contentType: string; content: string }): Promise<WrittenFile> => {
        const bytes = Buffer.from(input.content, 'base64');
        written.push({ filename: input.filename, contentType: input.contentType, bytes });
        return { url: `https://files.example/${input.filename}`, filename: input.filename, contentType: input.contentType, bytes: bytes.length };
      }
    },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  } as unknown as IntegrationContext<DatevConfig>;
  return { context, written, state };
}

function invoice(overrides: Partial<DocumentDto>): DocumentDto {
  return {
    id: `doc-${overrides.invoiceId ?? Math.random()}`,
    organizationId: 'org-1',
    category: 0,
    date: '2026-08-05',
    invoiceId: 'RE-2026-001',
    customer: 'Muster GmbH',
    customerId: 'K-100',
    total: '1190.00',
    tax: '19',
    taxValue: '190.00',
    eInvoiceCurrency: 'EUR',
    ...overrides
  };
}

function member(uid: string, displayName: string, extra: Partial<Member> = {}): Member {
  return { uid, email: `${uid}@example.com`, deleted: false, displayName, initials: 'XX', ...extra };
}

function task(user: string, start: string, seconds: number): TaskDto {
  return {
    id: `task-${user}-${start}`,
    user,
    running: false,
    paid: false,
    billed: false,
    billable: false,
    duration: seconds,
    durationBreak: 0,
    salaryTotal: '0',
    salaryBreak: '0',
    expensesTotal: '0',
    expensesPaid: '0',
    mileage: '0',
    deleted: false,
    lastUpdate: 0,
    created: 0,
    startDateTime: `${start}T08:00:00.000Z`,
    endDateTime: `${start}T16:00:00.000Z`
  };
}

function latin1(bytes: Buffer): string {
  return bytes.toString('latin1');
}

function lines(bytes: Buffer): string[] {
  const text = latin1(bytes);
  expect(text.endsWith('\r\n')).toBe(true);
  return text.slice(0, -2).split('\r\n');
}

const debtorMappings: MappingRecord[] = [
  { localId: 'K-100', externalId: '10001', syncStatus: 'SYNCED' },
  { localId: 'Beispiel AG', externalId: '10002', syncStatus: 'SYNCED' }
];

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

describe('datev writer', () => {
  it('rounds HALF_EVEN on decimal strings', () => {
    expect(toScaled('1.005', 2)).toBe('1.00');
    expect(toScaled('1.015', 2)).toBe('1.02');
    expect(toScaled('1.025', 2)).toBe('1.02');
    expect(toScaled('1.0251', 2)).toBe('1.03');
    expect(toScaled('2.675', 2)).toBe('2.68');
    expect(toScaled('-0.004', 2)).toBe('0.00');
    expect(toScaled('-1.5', 0)).toBe('-2');
    expect(toScaled('0.5', 0)).toBe('0');
    expect(toScaled('1.5', 0)).toBe('2');
    expect(toScaled(19, 2)).toBe('19.00');
    expect(toScaled('999.999', 2)).toBe('1000.00');
    expect(addDecimals('0.10', '0.20', 2)).toBe('0.30');
    expect(addDecimals('-1.00', '0.25', 2)).toBe('-0.75');
  });

  it('encodes Windows-1252 including the euro sign and umlauts', () => {
    const bytes = encodeSingleByte('Ä ö ß € ‚x‘ –', 'windows-1252');
    expect(Array.from(bytes)).toEqual([0xc4, 0x20, 0xf6, 0x20, 0xdf, 0x20, 0x80, 0x20, 0x82, 0x78, 0x91, 0x20, 0x96]);
    expect(Array.from(encodeSingleByte('€', 'iso-8859-1'))).toEqual([0x3f]);
    expect(Array.from(encodeSingleByte('日本', 'windows-1252'))).toEqual([0x3f, 0x3f]);
    expect(Array.from(encodeText('€', 'utf-8'))).toEqual([0xe2, 0x82, 0xac]);
  });

  it('formats dates and periods', () => {
    expect(formatDate('2026-08-05', 'DDMM')).toBe('0508');
    expect(formatDate('2026-08-05T10:00:00.000Z', 'DDMMYYYY')).toBe('05082026');
    expect(formatDate('2026-08-05', 'DD.MM.YYYY')).toBe('05.08.2026');
    expect(formatDate('2026-08-05', 'YYYYMMDD')).toBe('20260805');
    expect(monthBounds('2024-02-10')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(previousMonth(new Date(Date.UTC(2026, 0, 15)))).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(resolvePeriod({ from: '01.08.2026', to: '31.08.2026' })).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(resolvePeriod(undefined, new Date(Date.UTC(2026, 8, 14)))).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(() => resolvePeriod({ from: '2026-09-01', to: '2026-08-31' })).toThrow('liegt nach');
  });

  it('guards the period', () => {
    const guard = new PeriodGuard('2026-08-01', '2026-08-31');
    expect(guard.contains('2026-08-31')).toBe(true);
    expect(guard.contains('2026-09-01')).toBe(false);
    expect(() => guard.assert('2026-07-31', 'Beleg')).toThrow('außerhalb des Zeitraums');
    expect(guard.clamp('2026-07-30', '2026-08-03')).toEqual({ start: '2026-08-01', end: '2026-08-03' });
    expect(guard.clamp('2026-09-01', '2026-09-02')).toBeNull();
  });

  it('derives fiscal years from the configured start', () => {
    expect(parseWjBeginn('01.04.')).toEqual({ day: 1, month: 4 });
    expect(parseWjBeginn('')).toEqual({ day: 1, month: 1 });
    expect(() => parseWjBeginn('2026-04-01')).toThrow('TT.MM.');
    expect(fiscalYearStart('2026-03-15', { day: 1, month: 4 })).toBe('2025-04-01');
    expect(fiscalYearStart('2026-04-01', { day: 1, month: 4 })).toBe('2026-04-01');
    expect(fiscalYearEnd('2025-04-01')).toBe('2026-03-31');
    expect(fiscalYearEnd('2026-01-01')).toBe('2026-12-31');
  });
});

// ---------------------------------------------------------------------------
// Buchungsstapel
// ---------------------------------------------------------------------------

describe('datev buildBuchungsstapel', () => {
  const documents: DocumentDto[] = [
    invoice({ invoiceId: 'RE-2026-001', date: '2026-08-05', dueDate: '2026-08-19', deliveryDate: '2026-08-04', costCenter: 'KST1' }),
    invoice({ invoiceId: 'GS-2026-002', date: '2026-08-10', total: '-119.00', taxValue: '-19.00', invoiceTypeCode: '381' }),
    invoice({
      invoiceId: 'RE-2026-003',
      date: '2026-08-15',
      customer: 'Beispiel AG',
      customerId: '',
      customerVatId: 'ATU12345678',
      total: '500.00',
      tax: '0',
      taxValue: '0.00',
      isReverseCharge: true
    }),
    invoice({ invoiceId: 'RE-2026-004', date: '2026-08-20', customer: 'Unbekannt KG', customerId: '', total: '214.00', tax: '7', taxValue: '14.00' }),
    invoice({ invoiceId: 'RE-2026-005', date: '2026-08-21', showSecondTax: true, taxSecond: '5', taxSecondValue: '50.00' }),
    invoice({ invoiceId: 'RE-2026-006', date: '2026-08-22', customer: 'Steuerfrei e.V.', customerId: '', total: '100.00', tax: '0', taxValue: '0.00', taxExemptionReason: 'Kleinunternehmer' })
  ];

  function expectedRow(cells: Record<number, string>): string {
    const row = new Array(EXTF_COLUMNS.length).fill('');
    for (const [index, value] of Object.entries(cells)) row[Number(index)] = value;
    return row.join(';');
  }

  it('writes an EXTF file with header, 125 columns and one booking per invoice', async () => {
    const h = createHarness({ documents, mappings: { customer: debtorMappings } });
    const result = await buildBuchungsstapel({ from: '2026-08-01', to: '2026-08-31' }, h.context);

    expect(result.surface).toBe('buchungsstapel');
    expect(result.count).toBe(5);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].filename).toBe('EXTF_Buchungsstapel_20260801-20260831.csv');
    expect(h.written[0].contentType).toBe('text/csv');

    const rows = lines(h.written[0].bytes);
    expect(rows).toHaveLength(2 + 5);

    const header = rows[0].split(';');
    expect(header).toHaveLength(31);
    expect(header.slice(0, 5)).toEqual(['"EXTF"', '700', '21', '"Buchungsstapel"', '12']);
    expect(header[5]).toMatch(/^\d{17}$/);
    expect(header[7]).toBe('"TS"');
    expect(header.slice(10, 16)).toEqual(['1234567', '12345', '20260101', '4', '20260801', '20260831']);
    expect(header[16]).toBe('"Timesheet 2026-08"');
    expect(header.slice(18, 22)).toEqual(['1', '0', '0', '"EUR"']);
    expect(header[26]).toBe('"03"');

    expect(rows[1].split(';')).toHaveLength(125);
    expect(rows[1].startsWith('"Umsatz (ohne Soll/Haben-Kz)";"Soll/Haben-Kennzeichen";"WKZ Umsatz";"Kurs";')).toBe(true);
    expect(rows[1].endsWith(';"Abw. Skontokonto"')).toBe(true);

    expect(rows[2]).toBe(
      expectedRow({
        0: '1190,00',
        1: '"S"',
        2: '"EUR"',
        6: '10001',
        7: '8400',
        8: '""',
        9: '0508',
        10: '"RE-2026-001"',
        13: '"Muster GmbH RE-2026-001"',
        36: '"KST1"',
        113: '0',
        114: '04082026',
        116: '19082026'
      })
    );
    const creditNote = rows[3].split(';');
    expect([creditNote[0], creditNote[1], creditNote[6], creditNote[7], creditNote[9], creditNote[10]]).toEqual([
      '119,00',
      '"H"',
      '10001',
      '8400',
      '1008',
      '"GS-2026-002"'
    ]);
    const reverseCharge = rows[4].split(';');
    expect([reverseCharge[0], reverseCharge[1], reverseCharge[6], reverseCharge[7], reverseCharge[39]]).toEqual([
      '500,00',
      '"S"',
      '10002',
      '8336',
      '"ATU12345678"'
    ]);
    const unmapped = rows[5].split(';');
    expect([unmapped[0], unmapped[6], unmapped[7]]).toEqual(['214,00', '10000', '8300']);
    const exempt = rows[6].split(';');
    expect([exempt[0], exempt[6], exempt[7]]).toEqual(['100,00', '10000', '8100']);

    const codes = result.warnings.map(w => w.code).sort();
    expect(codes).toEqual(['customer_unmapped', 'customer_unmapped', 'second_tax']);
    expect(result.warnings.find(w => w.code === 'second_tax')?.details).toMatchObject({ invoiceId: 'RE-2026-005' });

    expect(h.context.data.listDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', category: 0, startDate: '2026-08-01', endDate: '2026-08-31' })
    );
  });

  it('encodes umlauts in Windows-1252 and quotes embedded quotes', async () => {
    const h = createHarness({
      documents: [invoice({ invoiceId: 'RE-2026-010', customer: 'Müller "Söhne" GmbH', customerId: 'K-200' })],
      mappings: { customer: [{ localId: 'K-200', externalId: '10009', syncStatus: 'SYNCED' }] }
    });
    await buildBuchungsstapel({ from: '2026-08-01', to: '2026-08-31' }, h.context);
    const row = lines(h.written[0].bytes)[2];
    expect(row).toContain('"Müller ""Söhne"" GmbH RE-2026-010"');
    expect(h.written[0].bytes.includes(Buffer.from([0xfc]))).toBe(true);
    expect(h.written[0].bytes.includes(Buffer.from([0xc3, 0xbc]))).toBe(false);
  });

  it('writes UTF-8 when configured', async () => {
    const h = createHarness({ documents: [invoice({ customer: 'Müller' })], config: { charset: 'utf-8' } });
    await buildBuchungsstapel({ from: '2026-08-01', to: '2026-08-31' }, h.context);
    expect(h.written[0].bytes.includes(Buffer.from([0xc3, 0xbc]))).toBe(true);
  });

  it('rejects a document outside the declared period', async () => {
    const h = createHarness({ documents: [invoice({ invoiceId: 'RE-2026-099', date: '2026-09-01' })] });
    await expect(buildBuchungsstapel({ from: '2026-08-01', to: '2026-08-31' }, h.context)).rejects.toThrow('außerhalb des Zeitraums');
    expect(h.written).toHaveLength(0);
  });

  it('splits a period that crosses the fiscal year into one file per year', async () => {
    const h = createHarness({
      documents: [invoice({ invoiceId: 'RE-2026-020', date: '2026-03-15' }), invoice({ invoiceId: 'RE-2026-021', date: '2026-04-10' })],
      config: { wirtschaftsjahrBeginn: '01.04.' }
    });
    const result = await buildBuchungsstapel({ from: '2026-03-01', to: '2026-04-30' }, h.context);
    expect(result.files.map(f => f.filename)).toEqual([
      'EXTF_Buchungsstapel_20260301-20260331.csv',
      'EXTF_Buchungsstapel_20260401-20260430.csv'
    ]);
    const first = lines(h.written[0].bytes)[0].split(';');
    const second = lines(h.written[1].bytes)[0].split(';');
    expect([first[12], first[14], first[15]]).toEqual(['20250401', '20260301', '20260331']);
    expect([second[12], second[14], second[15]]).toEqual(['20260401', '20260401', '20260430']);
    expect(result.warnings.map(w => w.code)).toContain('fiscal_year_split');
  });

  it('skips foreign currency and unsupported tax rates with warnings', async () => {
    const h = createHarness({
      documents: [
        invoice({ invoiceId: 'RE-2026-030', eInvoiceCurrency: 'CHF' }),
        invoice({ invoiceId: 'RE-2026-031', tax: '16', taxValue: '160.00' })
      ]
    });
    const result = await buildBuchungsstapel({ from: '2026-08-01', to: '2026-08-31' }, h.context);
    expect(result.count).toBe(0);
    expect(result.warnings.map(w => w.code).sort()).toEqual(['foreign_currency', 'unsupported_tax_rate']);
  });

  it('requires an organization installation', async () => {
    const h = createHarness({ organizationId: null });
    await expect(buildBuchungsstapel({ from: '2026-08-01', to: '2026-08-31' }, h.context)).rejects.toThrow('für eine Organisation installiert');
  });

  it('requires Beraternummer and Mandantennummer', async () => {
    const h = createHarness({ config: { beraternummer: '' } });
    await expect(buildBuchungsstapel({ from: '2026-08-01', to: '2026-08-31' }, h.context)).rejects.toThrow('Beraternummer');
  });
});

// ---------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------

describe('datev buildPayroll', () => {
  const colleagues = [
    member('u1', 'Erika Muster', { firstname: 'Erika', lastname: 'Muster', employeeId: '00001' }),
    member('u2', 'Max Beispiel'),
    member('u3', 'Ohne Nummer')
  ];
  const tasks = [task('u1', '2026-08-03', 28800), task('u1', '2026-08-04', 28800), task('u2', '2026-08-05', 14400), task('u3', '2026-08-05', 3600)];
  const absenceTypes: AbsenceTypeDto[] = [
    { id: 't-urlaub', name: 'Urlaub', active: true },
    { id: 't-krank', name: 'Krankheit', active: true },
    { id: 't-alt', name: 'Alt', active: false }
  ];
  const absences: AbsenceDto[] = [
    { id: 'a1', member: colleagues[0], absenceTypeId: 't-urlaub', startDateTime: '2026-08-10T00:00:00.000Z', endDateTime: '2026-08-14T00:00:00.000Z', fullDay: true, totalDays: '5', totalHours: '40', status: 'approved' },
    { id: 'a2', member: colleagues[1], absenceTypeId: 't-krank', startDateTime: '2026-07-30T00:00:00.000Z', endDateTime: '2026-08-03T00:00:00.000Z', fullDay: true, totalDays: '5', totalHours: '40', status: 'approved' }
  ];
  const overtime: OvertimeBalanceDto[] = [{ id: 'o1', member: colleagues[0], periodStart: '2026-08-01', periodEnd: '2026-08-31', overtimeMinutes: 120, undertimeMinutes: 0 }];
  const mappings = {
    user: [{ localId: 'u2', externalId: '00002', syncStatus: 'SYNCED' as const }],
    absence_type: [{ localId: 't-urlaub', externalId: '300', syncStatus: 'SYNCED' as const }]
  };

  it('emits LODAS Stammdaten and Bewegungsdaten and reports skipped employees', async () => {
    const h = createHarness({ colleagues, tasks, absences, absenceTypes, overtime, mappings });
    const result = await buildPayroll({ from: '2026-08-01', to: '2026-08-31' }, h.context);

    expect(result.files.map(f => f.filename)).toEqual(['LODAS_Stammdaten_20260801.txt', 'LODAS_Bewegungsdaten_20260801.txt']);
    expect(result.count).toBe(4);

    const stammdaten = lines(h.written[0].bytes);
    expect(stammdaten.slice(0, 3)).toEqual(['[Allgemein]', 'Ziel=LODAS', 'Version_SST=1.0']);
    expect(stammdaten).toContain('BeraterNr=1234567');
    expect(stammdaten).toContain('MandantenNr=12345');
    expect(stammdaten).toContain('100;u_lod_psd_mitarbeiter;pnr_betriebliche#psd;duevo_familienname#psd;duevo_vorname#psd;');
    const stammIndex = stammdaten.indexOf('[Stammdaten]');
    expect(stammdaten.slice(stammIndex + 1)).toEqual(['100;"00001";"Muster";"Erika";', '100;"00002";"Beispiel";"Max";']);

    const bewegung = lines(h.written[1].bytes);
    expect(bewegung).toContain('200;u_lod_bwd_buchung_standard;pnr#bwd;abrechnung_zeitraum#bwd;la_eigene#bwd;bs_wert_butab#bwd;bs_nr#bwd;kostenstelle#bwd;');
    const dataIndex = bewegung.indexOf('[Bewegungsdaten]');
    expect(bewegung.slice(dataIndex + 1)).toEqual([
      '200;"00001";01.08.2026;100;16,00;1;;',
      '200;"00001";01.08.2026;200;2,00;1;;',
      '200;"00001";01.08.2026;300;5,00;2;;',
      '200;"00002";01.08.2026;100;4,00;1;;'
    ]);

    const codes = result.warnings.map(w => w.code).sort();
    expect(codes).toEqual(['absence_prorated', 'absence_type_unmapped', 'employee_without_personalnummer']);
    expect(result.warnings.find(w => w.code === 'employee_without_personalnummer')?.details).toMatchObject({ displayName: 'Ohne Nummer' });
    expect(result.warnings.find(w => w.code === 'absence_type_unmapped')?.details).toMatchObject({ absenceTypeName: 'Krankheit' });

    expect(h.context.data.listAbsences).toHaveBeenCalledWith(expect.objectContaining({ startDate: '2026-08-01', endDate: '2026-08-31', statuses: ['approved'] }));
    expect(h.context.data.listTasks).toHaveBeenCalledWith(expect.objectContaining({ userIds: ['u1', 'u2', 'u3'] }));
  });

  it('emits one Lohn und Gehalt file with a header row', async () => {
    const h = createHarness({ colleagues, tasks, absences, absenceTypes, overtime, mappings, config: { payrollTarget: 'LUG', mandantLohn: '777' } });
    const result = await buildPayroll({ from: '2026-08-01', to: '2026-08-31' }, h.context);
    expect(result.files.map(f => f.filename)).toEqual(['LuG_Bewegungsdaten_20260801.txt']);
    expect(lines(h.written[0].bytes)).toEqual([
      'Mandant;Personalnummer;Abrechnungsmonat;Lohnart;Anzahl;Betrag;Kostenstelle;Bemerkung',
      '777;00001;08/2026;100;16,00;;;Arbeitsstunden',
      '777;00001;08/2026;200;2,00;;;Überstunden',
      '777;00001;08/2026;300;5,00;;;Urlaub',
      '777;00002;08/2026;100;4,00;;;Arbeitsstunden'
    ]);
  });

  const expenses: ExpenseDto[] = [
    { id: 'e1', user: 'u1', member: colleagues[0], amount: '26.40', refunded: false, deleted: false, lastUpdate: 0, created: 0, description: 'Verpflegungsmehraufwand München', dateTime: '2026-08-11T08:00:00.000Z' },
    { id: 'e2', user: 'u1', member: colleagues[0], amount: '15.00', refunded: false, deleted: false, lastUpdate: 0, created: 0, description: 'Übernachtung Hamburg', dateTime: '2026-08-11T20:00:00.000Z' },
    { id: 'e3', user: 'u1', member: colleagues[0], amount: '99.00', refunded: false, deleted: false, lastUpdate: 0, created: 0, description: 'Parkgebuehr', dateTime: '2026-08-12T08:00:00.000Z' },
    { id: 'e4', user: 'u1', member: colleagues[0], amount: '10.00', refunded: false, deleted: false, lastUpdate: 0, created: 0, description: 'Verpflegungspauschale Köln', dateTime: '2026-09-02T08:00:00.000Z' }
  ];

  it('exports travel allowances from expenses as amount lines', async () => {
    const h = createHarness({
      colleagues: [colleagues[0]],
      tasks: [tasks[0]],
      expenses,
      config: { lohnartVerpflegung: '500', lohnartUebernachtung: '501' }
    });
    const result = await buildPayroll({ from: '2026-08-01', to: '2026-08-31' }, h.context);
    expect(h.context.data.listExpenses).toHaveBeenCalledWith(expect.objectContaining({ startDate: '2026-08-01', endDate: '2026-08-31' }));
    const bewegung = lines(h.written[1].bytes);
    const dataIndex = bewegung.indexOf('[Bewegungsdaten]');
    expect(bewegung.slice(dataIndex + 1)).toEqual([
      '200;"00001";01.08.2026;100;8,00;1;;',
      '200;"00001";01.08.2026;500;26,40;3;;',
      '200;"00001";01.08.2026;501;15,00;3;;'
    ]);
    expect(result.count).toBe(3);
    expect(result.warnings).toEqual([]);

    const lug = createHarness({
      colleagues: [colleagues[0]],
      tasks: [tasks[0]],
      expenses,
      config: { payrollTarget: 'LUG', lohnartVerpflegung: '500', lohnartUebernachtung: '501' }
    });
    await buildPayroll({ from: '2026-08-01', to: '2026-08-31' }, lug.context);
    expect(lines(lug.written[0].bytes).slice(1)).toEqual([
      '12345;00001;08/2026;100;8,00;;;Arbeitsstunden',
      '12345;00001;08/2026;500;;26,40;;Verpflegungsmehraufwand',
      '12345;00001;08/2026;501;;15,00;;Übernachtungskosten'
    ]);
  });

  it('warns when expenses match a keyword but no Lohnart is configured', async () => {
    const h = createHarness({ colleagues: [colleagues[0]], tasks: [tasks[0]], expenses, config: { lohnartVerpflegung: '500' } });
    const result = await buildPayroll({ from: '2026-08-01', to: '2026-08-31' }, h.context);
    expect(result.warnings.map(w => w.code)).toEqual(['expense_lohnart_missing']);
    expect(result.warnings[0].details).toMatchObject({ keyword: 'Übernachtung' });
    const bewegung = lines(h.written[1].bytes);
    expect(bewegung.filter(l => l.includes(';501;'))).toEqual([]);
    expect(bewegung.filter(l => l.includes(';500;'))).toEqual(['200;"00001";01.08.2026;500;26,40;3;;']);
  });

  it('skips expense keywords that are left empty', async () => {
    const h = createHarness({ colleagues: [colleagues[0]], tasks: [tasks[0]], expenses, config: { verpflegungKeyword: '', uebernachtungKeyword: '' } });
    const result = await buildPayroll({ from: '2026-08-01', to: '2026-08-31' }, h.context);
    expect(h.context.data.listExpenses).not.toHaveBeenCalled();
    expect(result.warnings).toEqual([]);
  });

  it('prorates an absence that crosses the period boundary', async () => {
    const h = createHarness({
      colleagues: [colleagues[1]],
      absences: [absences[1]],
      absenceTypes,
      mappings: { user: mappings.user, absence_type: [{ localId: 't-krank', externalId: '400', syncStatus: 'SYNCED' }] }
    });
    const result = await buildPayroll({ from: '2026-08-01', to: '2026-08-31' }, h.context);
    const bewegung = lines(h.written[1].bytes);
    expect(bewegung[bewegung.length - 1]).toBe('200;"00002";01.08.2026;400;3,00;2;;');
    expect(result.warnings.map(w => w.code)).toEqual(['absence_prorated']);
  });

  it('rejects a payroll period spanning more than one calendar month', async () => {
    const h = createHarness({ colleagues, tasks, absences, absenceTypes, overtime, mappings });
    await expect(buildPayroll({ from: '2026-08-01', to: '2026-09-30' }, h.context)).rejects.toThrow('innerhalb eines Kalendermonats');
    expect(h.context.data.listTasks).not.toHaveBeenCalled();
    expect(h.written).toHaveLength(0);
  });

  it('books a partial month on the first day of its Abrechnungsmonat', async () => {
    const h = createHarness({ colleagues: [colleagues[0]], tasks: [task('u1', '2026-08-17', 28800)] });
    await buildPayroll({ from: '2026-08-15', to: '2026-08-31' }, h.context);
    const bewegung = lines(h.written[1].bytes);
    expect(bewegung.slice(bewegung.indexOf('[Bewegungsdaten]') + 1)).toEqual(['200;"00001";01.08.2026;100;8,00;1;;']);
  });

  it('warns when no wage type for worked hours is configured', async () => {
    const h = createHarness({ colleagues: [colleagues[0]], tasks: [tasks[0]], config: { lohnartArbeitsstunden: '' } });
    const result = await buildPayroll({ from: '2026-08-01', to: '2026-08-31' }, h.context);
    expect(result.count).toBe(0);
    expect(result.warnings.map(w => w.code)).toEqual(['wage_type_hours_missing']);
  });
});

// ---------------------------------------------------------------------------
// Monthly run, lists and history
// ---------------------------------------------------------------------------

describe('datev monthly run, lists and history', () => {
  it('runs both surfaces for the previous month and records history', async () => {
    const h = createHarness({ documents: [], colleagues: [] });
    const monthly = await buildMonthly(undefined, h.context);
    expect(monthly.results.map(r => r.surface)).toEqual(['buchungsstapel', 'payroll']);
    expect(monthly.period).toEqual(previousMonth());

    const history = await listHistory(undefined, h.context);
    expect(history.items).toHaveLength(2);
    expect(history.items[0].surface).toBe('Lohndaten');
    expect(history.items[1].surface).toBe('Buchungsstapel');
    expect(history.items[1].period).toBe(`${formatDate(monthly.period.from, 'DD.MM.YYYY')} bis ${formatDate(monthly.period.to, 'DD.MM.YYYY')}`);
    expect(history.columns.map(c => c.key)).toEqual(['at', 'surface', 'period', 'files', 'count', 'warnings']);
  });

  it('honours the monthly toggles', async () => {
    const h = createHarness({ config: { monthlyLohn: false } });
    const monthly = await buildMonthly(undefined, h.context);
    expect(monthly.results.map(r => r.surface)).toEqual(['buchungsstapel']);
  });

  it('lists distinct customers from invoices', async () => {
    const h = createHarness({
      documents: [
        invoice({ invoiceId: 'A', customer: 'Muster GmbH', customerId: 'K-100' }),
        invoice({ invoiceId: 'B', customer: 'Muster GmbH', customerId: 'K-100' }),
        invoice({ invoiceId: 'C', customer: 'Beispiel AG', customerId: '' }),
        invoice({ invoiceId: 'D', customer: '', customerId: '' })
      ]
    });
    const customers = await listCustomers(undefined, h.context);
    expect(customers).toEqual([
      { id: 'Beispiel AG', name: 'Beispiel AG' },
      { id: 'K-100', name: 'Muster GmbH (K-100)' }
    ]);
    expect(h.context.data.listDocuments).toHaveBeenCalledWith(expect.objectContaining({ category: 0, organizationId: 'org-1' }));
  });

  it('lists active absence types', async () => {
    const h = createHarness({ absenceTypes: [{ id: 'b', name: 'Urlaub', active: true }, { id: 'a', name: 'Alt', active: false }, { id: 'c', code: 'SICK' }] });
    const types = await listAbsenceTypes(undefined, h.context);
    expect(types).toEqual([
      { id: 'c', name: 'SICK' },
      { id: 'b', name: 'Urlaub' }
    ]);
  });
});
