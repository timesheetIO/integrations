import type { IntegrationContext, Member } from '@timesheet/integration-sdk';
import type { FormatProfile } from './writer';
import { isoDate, previousMonth } from './writer';
import type { HistoryEntry, ResolvedConfig, SapConfig, Target } from './types';

export const SYSTEM = 'sap-solutions';
export const HISTORY_KEY = 'sap-solutions:history';
export const HISTORY_LIMIT = 12;

/** Local entity types used by the mapping schema; the web persists rows under these names. */
export const MAPPING_ENTITY = {
  employee: 'user',
  costObject: 'project',
  activityType: 'tag',
  absenceType: 'absence_type'
} as const;

const SEPARATORS: Record<string, string> = { ';': ';', ',': ',', tab: '\t', '|': '|' };
const DATE_FORMATS = ['DDMMYYYY', 'DD.MM.YYYY', 'YYYYMMDD', 'YYYY-MM-DD'] as const;

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Applies the manifest defaults so every handler works on a complete config. */
export function resolveConfig(config: SapConfig | undefined): ResolvedConfig {
  const c = config ?? {};
  return {
    target: oneOf(c.target, ['cats', 'successfactors'] as const, 'cats'),
    personnelNumber: text(c.personnelNumber, ''),
    companyCode: text(c.companyCode, ''),
    costObjectType: oneOf(c.costObjectType, ['wbs', 'costCenter', 'order'] as const, 'wbs'),
    defaultActivityType: text(c.defaultActivityType, ''),
    aggregation: oneOf(c.aggregation, ['day', 'task'] as const, 'day'),
    timeMode: oneOf(c.timeMode, ['duration', 'clock'] as const, 'duration'),
    defaultTimeType: text(c.defaultTimeType, ''),
    clockFormat: oneOf(c.clockFormat, ['24h', '12h'] as const, '24h'),
    includeAbsences: bool(c.includeAbsences, false),
    separator: SEPARATORS[c.separator ?? ';'] ?? ';',
    decimalMark: c.decimalMark === '.' ? '.' : ',',
    dateFormat: oneOf(c.dateFormat, DATE_FORMATS, 'YYYYMMDD'),
    charset: oneOf(c.charset, ['utf-8', 'windows-1252', 'iso-8859-1'] as const, 'utf-8'),
    headerRow: bool(c.headerRow, true),
    quoteText: bool(c.quoteText, false)
  };
}

/** Format profile of the CATS file, set by the customer to match their load program. */
export function catsProfile(cfg: ResolvedConfig): FormatProfile {
  return {
    separator: cfg.separator,
    quote: cfg.quoteText ? '"' : '',
    decimalMark: cfg.decimalMark,
    dateFormat: cfg.dateFormat,
    charset: cfg.charset,
    lineBreak: '\r\n'
  };
}

/**
 * Format profile of the SuccessFactors imports: comma separated, UTF-8, decimal point.
 * Dates are written by the builder in MM/DD/YYYY, the format SAP prescribes for the
 * Employee Time import and selectable for External Time Data.
 */
export const SUCCESSFACTORS_PROFILE: FormatProfile = {
  separator: ',',
  quote: '',
  decimalMark: '.',
  dateFormat: 'YYYY-MM-DD',
  charset: 'utf-8',
  lineBreak: '\r\n'
};

export function resolvePeriod(input: { from?: string; to?: string } | undefined): { from: string; to: string } {
  if (input?.from || input?.to) {
    if (!input.from || !input.to) {
      throw new Error('Please enter the full period (from and to).');
    }
    return { from: isoDate(input.from), to: isoDate(input.to) };
  }
  return previousMonth();
}

/**
 * Pages through a list endpoint until a short page or an empty page arrives.
 * Stops defensively when a page repeats its first item, which happens when the
 * endpoint counts pages from the other base than expected.
 */
export async function pageAll<T extends { id: string }>(
  fetchPage: (page: number) => Promise<{ items?: T[] } | null | undefined>,
  options: { firstPage: number; limit: number; maxPages?: number }
): Promise<T[]> {
  const out: T[] = [];
  const maxPages = options.maxPages ?? 500;
  let previousFirstId: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = options.firstPage + i;
    const result = await fetchPage(page);
    const items = result?.items ?? [];
    if (items.length === 0) break;
    if (previousFirstId !== undefined && items[0]?.id === previousFirstId) break;
    previousFirstId = items[0]?.id;
    out.push(...items);
    if (items.length < options.limit) break;
  }
  return out;
}

/** localId to externalId for one mapping entity, empty external ids dropped. */
export async function loadMappingIndex(
  context: IntegrationContext<SapConfig>,
  entity: string
): Promise<Map<string, string>> {
  const rows = await context.mappings.list({ system: SYSTEM, entity });
  const index = new Map<string, string>();
  for (const row of rows) {
    const externalId = (row.externalId ?? '').trim();
    if (row.localId && externalId) {
      index.set(row.localId, externalId);
    }
  }
  return index;
}

export function memberName(member: Member | undefined, fallback: string): string {
  if (!member) return fallback;
  const full = [member.firstname, member.lastname].filter(Boolean).join(' ').trim();
  return member.displayName || full || member.email || fallback;
}

export async function recordRun(
  context: IntegrationContext<SapConfig>,
  entry: Omit<HistoryEntry, 'id' | 'at'>
): Promise<HistoryEntry> {
  const full: HistoryEntry = {
    id: globalThis.crypto.randomUUID(),
    at: new Date().toISOString(),
    ...entry
  };
  const current = (await context.state.get<HistoryEntry[]>(HISTORY_KEY)) ?? [];
  const list = Array.isArray(current) ? current : [];
  const next = [full, ...list.filter(item => item && item.id !== full.id)].slice(0, HISTORY_LIMIT);
  await context.state.set(HISTORY_KEY, next);
  return full;
}

export const TARGET_LABELS: Record<Target, string> = {
  cats: 'CATS',
  successfactors: 'SuccessFactors'
};

export function exportFilename(kind: 'CATS' | 'ExternalTimeData' | 'EmployeeTime', from: string, to: string): string {
  return `${kind}_${from}_${to}.csv`;
}
