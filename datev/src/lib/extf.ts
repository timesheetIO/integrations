import type { ResolvedConfig } from './types';
import { FormatProfile, RecordWriter, absDecimal, formatDate, isoDate, toScaled } from './writer';

/**
 * DATEV-Format (EXTF) Buchungsstapel writer.
 *
 * Layout implemented: DATEV-Format version 700, format category 21 "Buchungsstapel",
 * Buchungsstapel format version 12 with the 125 column header row. Column names and
 * order live in EXTF_COLUMNS so a layout correction is a single edit. Verify the
 * header row against the current DATEV-Formatbeschreibung before the first import.
 */

export const EXTF_FORMAT_CATEGORY = 21;
export const EXTF_FORMAT_NAME = 'Buchungsstapel';
export const EXTF_BUCHUNGSSTAPEL_VERSION = 12;
export const EXTF_ORIGIN = 'TS';

export const EXTF_COLUMNS: readonly string[] = [
  'Umsatz (ohne Soll/Haben-Kz)',
  'Soll/Haben-Kennzeichen',
  'WKZ Umsatz',
  'Kurs',
  'Basis-Umsatz',
  'WKZ Basis-Umsatz',
  'Konto',
  'Gegenkonto (ohne BU-Schlüssel)',
  'BU-Schlüssel',
  'Belegdatum',
  'Belegfeld 1',
  'Belegfeld 2',
  'Skonto',
  'Buchungstext',
  'Postensperre',
  'Diverse Adressnummer',
  'Geschäftspartnerbank',
  'Sachverhalt',
  'Zinssperre',
  'Beleglink',
  'Beleginfo - Art 1',
  'Beleginfo - Inhalt 1',
  'Beleginfo - Art 2',
  'Beleginfo - Inhalt 2',
  'Beleginfo - Art 3',
  'Beleginfo - Inhalt 3',
  'Beleginfo - Art 4',
  'Beleginfo - Inhalt 4',
  'Beleginfo - Art 5',
  'Beleginfo - Inhalt 5',
  'Beleginfo - Art 6',
  'Beleginfo - Inhalt 6',
  'Beleginfo - Art 7',
  'Beleginfo - Inhalt 7',
  'Beleginfo - Art 8',
  'Beleginfo - Inhalt 8',
  'KOST1 - Kostenstelle',
  'KOST2 - Kostenstelle',
  'Kost-Menge',
  'EU-Land u. UStID (Bestimmung)',
  'EU-Steuersatz (Bestimmung)',
  'Abw. Versteuerungsart',
  'Sachverhalt L+L',
  'Funktionsergänzung L+L',
  'BU 49 Hauptfunktionstyp',
  'BU 49 Hauptfunktionsnummer',
  'BU 49 Funktionsergänzung',
  ...Array.from({ length: 20 }, (_, i) => [`Zusatzinformation - Art ${i + 1}`, `Zusatzinformation- Inhalt ${i + 1}`]).flat(),
  'Stück',
  'Gewicht',
  'Zahlweise',
  'Forderungsart',
  'Veranlagungsjahr',
  'Zugeordnete Fälligkeit',
  'Skontotyp',
  'Auftragsnummer',
  'Buchungstyp',
  'USt-Schlüssel (Anzahlungen)',
  'EU-Land (Anzahlungen)',
  'Sachverhalt L+L (Anzahlungen)',
  'EU-Steuersatz (Anzahlungen)',
  'Erlöskonto (Anzahlungen)',
  'Herkunft-Kz',
  'Buchungs GUID',
  'KOST-Datum',
  'SEPA-Mandatsreferenz',
  'Skontosperre',
  'Gesellschaftername',
  'Beteiligtennummer',
  'Identifikationsnummer',
  'Zeichnernummer',
  'Postensperre bis',
  'Bezeichnung SoBil-Sachverhalt',
  'Kennzeichen SoBil-Buchung',
  'Festschreibung',
  'Leistungsdatum',
  'Datum Zuord. Steuerperiode',
  'Fälligkeit',
  'Generalumkehr (GU)',
  'Steuersatz',
  'Land',
  'Abrechnungsreferenz',
  'BVV-Position',
  'EU-Land u. UStID (Ursprung)',
  'EU-Steuersatz (Ursprung)',
  'Abw. Skontokonto'
];

const COL = (name: string): number => {
  const idx = EXTF_COLUMNS.indexOf(name);
  if (idx < 0) throw new Error(`Unknown EXTF column ${name}`);
  return idx;
};

export interface Booking {
  /** Gross amount, positive, decimal string. */
  amount: string;
  /** S: Konto is debited (invoice), H: Konto is credited (credit note). */
  sollHaben: 'S' | 'H';
  currency: string;
  /** Debtor account. */
  konto: string;
  /** Revenue account. */
  gegenkonto: string;
  buSchluessel: string;
  /** yyyy-MM-dd */
  belegdatum: string;
  belegfeld1: string;
  buchungstext: string;
  kost1?: string;
  /** Country code plus VAT id of the customer, for reverse charge bookings. */
  euLandUstId?: string;
  /** yyyy-MM-dd */
  faelligkeit?: string;
  /** yyyy-MM-dd */
  leistungsdatum?: string;
}

export interface ExtfFileOptions {
  config: ResolvedConfig;
  /** Period covered by this file, inside one fiscal year. */
  from: string;
  to: string;
  /** Fiscal year start for this file, yyyy-MM-dd. */
  wjBeginn: string;
  createdAt: Date;
  exportedBy: string;
  bezeichnung?: string;
}

export function extfProfile(charset: ResolvedConfig['charset']): FormatProfile {
  return {
    separator: ';',
    quote: '"',
    decimalMark: ',',
    dateFormat: 'DDMM',
    charset,
    lineBreak: '\r\n'
  };
}

/** Belegfeld 1 allows letters, digits and $ & % * + - /, at most 36 characters. */
export function sanitizeBelegfeld(value: string | undefined): string {
  return (value ?? '')
    .replace(/[^A-Za-z0-9$&%*+\-/]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 36);
}

export function timestamp17(date: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}${p(date.getUTCMilliseconds(), 3)}`
  );
}

export function extfHeader(w: RecordWriter, opts: ExtfFileOptions): string[] {
  const c = opts.config;
  const bezeichnung = opts.bezeichnung ?? `Timesheet ${isoDate(opts.from).slice(0, 7)}`;
  return [
    w.text('EXTF'),
    w.raw(c.formatVersion),
    w.raw(String(EXTF_FORMAT_CATEGORY)),
    w.text(EXTF_FORMAT_NAME),
    w.raw(String(EXTF_BUCHUNGSSTAPEL_VERSION)),
    w.raw(timestamp17(opts.createdAt)),
    w.raw(''),
    w.text(EXTF_ORIGIN),
    w.text(opts.exportedBy.slice(0, 25)),
    w.raw(''),
    w.raw(c.beraternummer),
    w.raw(c.mandantennummer),
    w.raw(formatDate(opts.wjBeginn, 'YYYYMMDD')),
    w.raw(String(c.sachkontenlaenge)),
    w.raw(formatDate(opts.from, 'YYYYMMDD')),
    w.raw(formatDate(opts.to, 'YYYYMMDD')),
    w.text(bezeichnung, 30),
    w.text(''),
    w.raw('1'),
    w.raw('0'),
    w.raw(c.festschreibung ? '1' : '0'),
    w.text('EUR'),
    w.raw(''),
    w.raw(''),
    w.raw(''),
    w.raw(''),
    w.text(c.skr === 'SKR04' ? '04' : '03'),
    w.raw(''),
    w.raw(''),
    w.raw(''),
    w.text('')
  ];
}

export function extfRow(w: RecordWriter, booking: Booking, config: ResolvedConfig): string[] {
  const cells: string[] = new Array(EXTF_COLUMNS.length).fill('');
  cells[COL('Umsatz (ohne Soll/Haben-Kz)')] = w.number(absDecimal(toScaled(booking.amount, 2)), 2);
  cells[COL('Soll/Haben-Kennzeichen')] = w.text(booking.sollHaben);
  cells[COL('WKZ Umsatz')] = w.text(booking.currency);
  cells[COL('Konto')] = w.raw(booking.konto);
  cells[COL('Gegenkonto (ohne BU-Schlüssel)')] = w.raw(booking.gegenkonto);
  cells[COL('BU-Schlüssel')] = w.text(booking.buSchluessel);
  cells[COL('Belegdatum')] = w.date(booking.belegdatum, 'DDMM');
  cells[COL('Belegfeld 1')] = w.text(sanitizeBelegfeld(booking.belegfeld1));
  cells[COL('Buchungstext')] = w.text(booking.buchungstext, 60);
  if (booking.kost1) cells[COL('KOST1 - Kostenstelle')] = w.text(booking.kost1, 36);
  if (booking.euLandUstId) cells[COL('EU-Land u. UStID (Bestimmung)')] = w.text(booking.euLandUstId, 15);
  cells[COL('Festschreibung')] = w.raw(config.festschreibung ? '1' : '0');
  if (booking.leistungsdatum) cells[COL('Leistungsdatum')] = w.date(booking.leistungsdatum, 'DDMMYYYY');
  if (booking.faelligkeit) cells[COL('Fälligkeit')] = w.date(booking.faelligkeit, 'DDMMYYYY');
  return cells;
}

export function buildExtfFile(bookings: Booking[], opts: ExtfFileOptions): string {
  const w = new RecordWriter(extfProfile(opts.config.charset));
  const rows: string[][] = [extfHeader(w, opts), EXTF_COLUMNS.map(name => w.text(name))];
  for (const booking of bookings) {
    rows.push(extfRow(w, booking, opts.config));
  }
  return w.build(rows);
}

export function extfFilename(from: string, to: string): string {
  return `EXTF_Buchungsstapel_${formatDate(from, 'YYYYMMDD')}-${formatDate(to, 'YYYYMMDD')}.csv`;
}
