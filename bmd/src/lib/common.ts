import type { DocumentDto, IntegrationContext, Member } from '@timesheet/integration-sdk';
import type { FormatProfile } from './writer';
import { isoDate, previousMonth, toScaled } from './writer';
import type { BmdConfig, ExportSurface, HistoryEntry, ResolvedConfig } from './types';

export const SYSTEM = 'bmd';
export const HISTORY_KEY = 'bmd:history';
export const HISTORY_LIMIT = 12;

/** Local entity types used by the mapping schema; the web persists rows under these names. */
export const MAPPING_ENTITY = {
  employee: 'user',
  absenceType: 'absence_type',
  surchargeType: 'surcharge_type',
  customer: 'customer'
} as const;

/** Fixed local list behind the surcharge-types mapping. Ids are the mapping localIds. */
export const SURCHARGE_TYPES: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'normalstunden', name: 'Normalstunden (gearbeitete Zeit)' },
  { id: 'ueberstunden-50', name: 'Überstunden 50 %' },
  { id: 'ueberstunden-100', name: 'Überstunden 100 %' },
  { id: 'nachtarbeit', name: 'Nachtarbeit' },
  { id: 'sonntagsarbeit', name: 'Sonntagsarbeit' },
  { id: 'feiertagsarbeit', name: 'Feiertagsarbeit' },
  { id: 'seg-zulage', name: 'SEG-Zulage' },
  { id: 'taggeld', name: 'Taggeld' },
  { id: 'naechtigungsgeld', name: 'Nächtigungsgeld' }
];

const SEPARATORS: Record<string, string> = { ';': ';', ',': ',', tab: '\t', '|': '|' };

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Applies the manifest defaults so every handler works on a complete config. */
export function resolveConfig(config: BmdConfig | undefined): ResolvedConfig {
  const c = config ?? {};
  const decimalMark = c.decimalMark === '.' ? '.' : ',';
  return {
    firmennummer: text(c.firmennummer, ''),
    mandantennummer: text(c.mandantennummer, ''),
    buchungssymbol: text(c.buchungssymbol, 'AR'),
    erloeskonto20: text(c.erloeskonto20, '4000'),
    erloeskonto10: text(c.erloeskonto10, '4001'),
    erloeskonto13: text(c.erloeskonto13, '4002'),
    erloeskontoSteuerfrei: text(c.erloeskontoSteuerfrei, '4010'),
    erloeskontoReverseCharge: text(c.erloeskontoReverseCharge, '4020'),
    steuercode20: text(c.steuercode20, '1'),
    steuercode10: text(c.steuercode10, '2'),
    steuercode13: text(c.steuercode13, '3'),
    steuercodeSteuerfrei: text(c.steuercodeSteuerfrei, '9'),
    steuercodeReverseCharge: text(c.steuercodeReverseCharge, '22'),
    debitorStandard: text(c.debitorStandard, '20000'),
    gutschriftModus: c.gutschriftModus === 'negativ' ? 'negativ' : 'buchcode',
    kostenstelle: text(c.kostenstelle, ''),
    filiale: text(c.filiale, ''),
    charset: c.charset === 'utf-8' || c.charset === 'iso-8859-1' ? c.charset : 'windows-1252',
    separator: SEPARATORS[c.separator ?? ';'] ?? ';',
    decimalMark,
    dateFormat: c.dateFormat ?? 'DD.MM.YYYY',
    headerRow: bool(c.headerRow, true),
    quoteText: bool(c.quoteText, false),
    taggeldKeyword: text(c.taggeldKeyword, ''),
    naechtigungsgeldKeyword: text(c.naechtigungsgeldKeyword, ''),
    monthlyFibu: bool(c.monthlyFibu, true),
    monthlyLohn: bool(c.monthlyLohn, true)
  };
}

export function profileFromConfig(cfg: ResolvedConfig): FormatProfile {
  return {
    separator: cfg.separator,
    quote: cfg.quoteText ? '"' : '',
    decimalMark: cfg.decimalMark,
    dateFormat: cfg.dateFormat,
    charset: cfg.charset,
    lineBreak: '\r\n'
  };
}

export function requireOrganization(context: IntegrationContext<BmdConfig>): string {
  if (!context.organizationId) {
    throw new Error(
      'Die BMD-Integration muss für eine Organisation installiert sein. Auf einem persönlichen Profil gibt es keine Lohn- und Rechnungsdaten der Mitarbeiter.'
    );
  }
  return context.organizationId;
}

export function resolvePeriod(input: { from?: string; to?: string } | undefined): { from: string; to: string } {
  if (input?.from || input?.to) {
    if (!input.from || !input.to) {
      throw new Error('Bitte Zeitraum vollständig angeben (von und bis).');
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
  context: IntegrationContext<BmdConfig>,
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

/** The key a customer is mapped under: the customer number when present, else the name. */
export function customerKey(doc: Pick<DocumentDto, 'customerId' | 'customer'>): string {
  const id = (doc.customerId ?? '').trim();
  if (id) return id;
  return (doc.customer ?? '').trim();
}

export function isCreditNote(doc: DocumentDto): boolean {
  if ((doc.invoiceTypeCode ?? '').trim() === '381') return true;
  if ((doc.eInvoiceDocumentType ?? '').toUpperCase() === 'CREDIT_NOTE') return true;
  return toScaled(doc.total ?? '0', 2).startsWith('-');
}

export function memberName(member: Member | undefined, fallback: string): string {
  if (!member) return fallback;
  const full = [member.firstname, member.lastname].filter(Boolean).join(' ').trim();
  return member.displayName || full || member.email || fallback;
}

export async function recordRun(
  context: IntegrationContext<BmdConfig>,
  entry: Omit<HistoryEntry, 'id' | 'at'>
): Promise<HistoryEntry> {
  const full: HistoryEntry = {
    id: globalThis.crypto.randomUUID(),
    at: new Date().toISOString(),
    ...entry
  };
  const current = (await context.state.get<HistoryEntry[]>(HISTORY_KEY)) ?? [];
  const next = [full, ...current.filter(item => item && item.id !== full.id)].slice(0, HISTORY_LIMIT);
  await context.state.set(HISTORY_KEY, next);
  await context.state.set(`bmd:last-run:${entry.surface}`, full);
  return full;
}

export function exportFilename(surface: ExportSurface, from: string, to: string): string {
  return `BMD_${surface.toUpperCase()}_${from}_${to}.csv`;
}
