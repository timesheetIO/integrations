import type { IntegrationContext } from '@timesheet/integration-sdk';
import {
  DatevConfig,
  HISTORY_KEY,
  HISTORY_LIMIT,
  Period,
  PeriodInput,
  ResolvedConfig,
  RunRecord,
  SYSTEM
} from './types';
import { isoDate, previousMonth } from './writer';

/** Page size for every list call. */
export const PAGE_SIZE = 100;

/**
 * The backend only honours `page` when `count` (its total-size hint) exceeds `limit`;
 * otherwise it silently serves page 1 again. Sending a large hint makes paging work
 * without a first round trip to learn the real count.
 */
const COUNT_HINT = 1_000_000_000;

export function requireOrganization(context: IntegrationContext<unknown>): string {
  const organizationId = context.organizationId;
  if (!organizationId) {
    throw new Error(
      'DATEV Export must be installed for an organization. Personal installations have no invoices, absences or overtime to export.'
    );
  }
  return organizationId;
}

function asString(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  const s = String(value).trim();
  return s === '' ? fallback : s;
}

/** Like asString, but an explicitly empty value stays empty (used to switch a keyword off). */
function asStringOrEmpty(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function asInt(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'number' ? value : parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return String(value).toLowerCase() === 'true';
}

/** Parses "TT.MM." (also accepts "T.M", "TT.MM") into day and month. */
export function parseWjBeginn(value: string | undefined): { day: number; month: number } {
  const match = /^\s*(\d{1,2})\.(\d{1,2})\.?\s*$/.exec(value ?? '');
  if (!match) {
    if (!value || value.trim() === '') return { day: 1, month: 1 };
    throw new Error(`Wirtschaftsjahresbeginn "${value}" is not in the form TT.MM.`);
  }
  const day = Number(match[1]);
  const month = Number(match[2]);
  if (day < 1 || day > 31 || month < 1 || month > 12) {
    throw new Error(`Wirtschaftsjahresbeginn "${value}" is not a valid day and month`);
  }
  return { day, month };
}

const DEFAULT_ACCOUNTS = {
  SKR03: { standard: '8400', reduced: '8300', taxFree: '8100', reverseCharge: '8337' },
  SKR04: { standard: '4400', reduced: '4300', taxFree: '4100', reverseCharge: '4337' }
} as const;

export function resolveConfig(raw: DatevConfig | undefined): ResolvedConfig {
  const config = raw ?? {};
  const skr = config.skr === 'SKR04' ? 'SKR04' : 'SKR03';
  const accounts = DEFAULT_ACCOUNTS[skr];
  const beraternummer = asString(config.beraternummer, '');
  const mandantennummer = asString(config.mandantennummer, '');
  if (!/^\d{1,7}$/.test(beraternummer)) {
    throw new Error('Beraternummer is missing or not numeric (1 to 7 digits). Set it in the integration settings.');
  }
  if (!/^\d{1,5}$/.test(mandantennummer)) {
    throw new Error('Mandantennummer is missing or not numeric (1 to 5 digits). Set it in the integration settings.');
  }
  const sachkontenlaenge = asInt(config.sachkontenlaenge, 4);
  if (sachkontenlaenge < 4 || sachkontenlaenge > 8) {
    throw new Error('Sachkontenlaenge must be between 4 and 8.');
  }
  return {
    beraternummer,
    mandantennummer,
    skr,
    sachkontenlaenge,
    wirtschaftsjahrBeginn: parseWjBeginn(config.wirtschaftsjahrBeginn),
    formatVersion: asString(config.formatVersion, '700'),
    charset: config.charset === 'utf-8' ? 'utf-8' : 'windows-1252',
    festschreibung: asBool(config.festschreibung, false),
    steuersatzStandard: asString(config.steuersatzStandard, '19'),
    steuersatzErmaessigt: asString(config.steuersatzErmaessigt, '7'),
    erloeskontoStandard: asString(config.erloeskontoStandard, accounts.standard),
    erloeskontoErmaessigt: asString(config.erloeskontoErmaessigt, accounts.reduced),
    erloeskontoSteuerfrei: asString(config.erloeskontoSteuerfrei, accounts.taxFree),
    erloeskontoReverseCharge: asString(config.erloeskontoReverseCharge, accounts.reverseCharge),
    debitorStandard: asString(config.debitorStandard, '10000'),
    payrollTarget: config.payrollTarget === 'LUG' ? 'LUG' : 'LODAS',
    mandantLohn: asString(config.mandantLohn, mandantennummer),
    lohnartArbeitsstunden: asString(config.lohnartArbeitsstunden, ''),
    lohnartUeberstunden: asString(config.lohnartUeberstunden, ''),
    lohnartMinderstunden: asString(config.lohnartMinderstunden, ''),
    taggeldKeyword: asStringOrEmpty(config.taggeldKeyword, 'Taggeld'),
    naechtigungsgeldKeyword: asStringOrEmpty(config.naechtigungsgeldKeyword, 'Nächtigungsgeld'),
    lohnartTaggeld: asString(config.lohnartTaggeld, ''),
    lohnartNaechtigungsgeld: asString(config.lohnartNaechtigungsgeld, ''),
    customerWindowMonths: Math.max(1, asInt(config.customerWindowMonths, 24)),
    monthlyBuchungsstapel: asBool(config.monthlyBuchungsstapel, true),
    monthlyLohn: asBool(config.monthlyLohn, true)
  };
}

/** Accepts yyyy-MM-dd or dd.MM.yyyy and returns yyyy-MM-dd. */
export function parseInputDate(value: string | undefined, label: string): string | undefined {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const v = String(value).trim();
  const german = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(v);
  if (german) {
    return `${german[3]}-${german[2].padStart(2, '0')}-${german[1].padStart(2, '0')}`;
  }
  try {
    return isoDate(v);
  } catch {
    throw new Error(`${label}: "${value}" is not a date (use JJJJ-MM-TT or TT.MM.JJJJ)`);
  }
}

/** Resolves the requested period; a missing period means the previous calendar month. */
export function resolvePeriod(input: PeriodInput | undefined, now: Date = new Date()): Period {
  const from = parseInputDate(input?.from, 'Von');
  const to = parseInputDate(input?.to, 'Bis');
  if (!from && !to) {
    return previousMonth(now);
  }
  if (!from || !to) {
    throw new Error('Both "Von" and "Bis" are required for a custom period.');
  }
  if (from > to) {
    throw new Error(`"Von" (${from}) is after "Bis" (${to}).`);
  }
  return { from, to };
}

/** Fiscal year start (yyyy-MM-dd) containing the given date. */
export function fiscalYearStart(date: string, begin: { day: number; month: number }): string {
  const [y, m, d] = isoDate(date).split('-').map(Number);
  const mm = String(begin.month).padStart(2, '0');
  const dd = String(begin.day).padStart(2, '0');
  const sameYear = `${y}-${mm}-${dd}`;
  const target = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (target >= sameYear) return sameYear;
  return `${y - 1}-${mm}-${dd}`;
}

/** Last day (yyyy-MM-dd) of the fiscal year that starts on `start`. */
export function fiscalYearEnd(start: string): string {
  const [y, m, d] = isoDate(start).split('-').map(Number);
  const next = new Date(Date.UTC(y + 1, m - 1, d));
  next.setUTCDate(next.getUTCDate() - 1);
  return next.toISOString().slice(0, 10);
}

export async function pageAll<T>(
  fetchPage: (page: number, limit: number, count: number) => Promise<{ items?: T[] } | T[] | null | undefined>
): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= 10_000; page++) {
    const result = await fetchPage(page, PAGE_SIZE, COUNT_HINT);
    const items = Array.isArray(result) ? result : result?.items ?? [];
    all.push(...items);
    if (items.length < PAGE_SIZE) break;
  }
  return all;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** localId -> externalId for one mapping entity of this plugin. */
export async function loadMappingIndex(
  context: IntegrationContext<unknown>,
  entity: string
): Promise<Map<string, string>> {
  const records = await context.mappings.list({ system: SYSTEM, entity });
  const index = new Map<string, string>();
  for (const record of records ?? []) {
    const external = (record.externalId ?? '').trim();
    if (record.localId && external) index.set(record.localId, external);
  }
  return index;
}

export async function readHistory(context: IntegrationContext<unknown>): Promise<RunRecord[]> {
  const stored = await context.state.get<RunRecord[]>(HISTORY_KEY);
  return Array.isArray(stored) ? stored : [];
}

export async function recordRun(context: IntegrationContext<unknown>, record: RunRecord): Promise<void> {
  const history = await readHistory(context);
  const next = [record, ...history].slice(0, HISTORY_LIMIT);
  await context.state.set(HISTORY_KEY, next);
}

export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}
