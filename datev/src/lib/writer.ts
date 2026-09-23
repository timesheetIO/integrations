/**
 * Shared writer layer for accounting and payroll file exports.
 *
 * Kept byte-identical in integrations/datev/src/lib/writer.ts and
 * integrations/bmd/src/lib/writer.ts (plugins are published standalone, the same way
 * taskSync.ts is duplicated across the sync plugins). Fix both copies together.
 *
 * Runs inside the plugin isolate: no Node APIs, only globalThis.btoa / TextEncoder.
 */

export type DateFormat = 'DDMM' | 'DDMMYYYY' | 'DD.MM.YYYY' | 'YYYYMMDD' | 'YYYY-MM-DD';
export type Charset = 'windows-1252' | 'iso-8859-1' | 'utf-8';

export interface FormatProfile {
  /** Field separator, `;` for every DACH format in scope. */
  separator: string;
  /** Quote character for text fields, empty string for none. */
  quote: string;
  /** Decimal mark for numbers. */
  decimalMark: ',' | '.';
  /** Default date shape. */
  dateFormat: DateFormat;
  charset: Charset;
  lineBreak: '\r\n' | '\n';
}

// ---------------------------------------------------------------------------
// Decimal handling on strings, never on floats
// ---------------------------------------------------------------------------

/**
 * Formats a decimal string or number at a fixed scale using banker's rounding
 * (HALF_EVEN, matching the project money convention). Returns digits with a '.'
 * decimal point and no thousands separator; callers swap the mark via the profile.
 */
export function toScaled(value: string | number | null | undefined, scale: number): string {
  if (value === null || value === undefined || value === '') {
    value = '0';
  }
  let str = typeof value === 'number' ? value.toString() : String(value).trim();
  // Expand exponent notation defensively (1e-7 etc.).
  if (/e/i.test(str)) {
    str = Number(str).toFixed(Math.max(scale, 10));
  }
  let negative = false;
  if (str.startsWith('-')) {
    negative = true;
    str = str.slice(1);
  } else if (str.startsWith('+')) {
    str = str.slice(1);
  }
  if (!/^\d*(\.\d*)?$/.test(str)) {
    throw new Error(`Keine Dezimalzahl: ${value}`);
  }
  const [intPartRaw, fracRaw = ''] = str.split('.');
  const intPart = intPartRaw === '' ? '0' : intPartRaw;
  let digits = intPart + fracRaw.slice(0, scale).padEnd(scale, '0');
  const dropped = fracRaw.slice(scale);
  if (dropped.length > 0) {
    const first = dropped.charCodeAt(0) - 48;
    const rest = dropped.slice(1);
    const restNonZero = /[1-9]/.test(rest);
    const lastKept = digits.charCodeAt(digits.length - 1) - 48;
    let roundUp = false;
    if (first > 5) roundUp = true;
    else if (first === 5) roundUp = restNonZero || lastKept % 2 === 1;
    if (roundUp) {
      digits = incrementDigits(digits);
    }
  }
  const isZero = !/[1-9]/.test(digits);
  const intDigits = digits.slice(0, digits.length - scale).replace(/^0+(?=\d)/, '') || '0';
  const fracDigits = scale > 0 ? digits.slice(digits.length - scale) : '';
  const body = scale > 0 ? `${intDigits}.${fracDigits}` : intDigits;
  return negative && !isZero ? `-${body}` : body;
}

function incrementDigits(digits: string): string {
  const arr = digits.split('');
  let i = arr.length - 1;
  while (i >= 0) {
    if (arr[i] === '9') {
      arr[i] = '0';
      i--;
    } else {
      arr[i] = String.fromCharCode(arr[i].charCodeAt(0) + 1);
      return arr.join('');
    }
  }
  return '1' + arr.join('');
}

/** Absolute value of a scaled decimal string. */
export function absDecimal(scaled: string): string {
  return scaled.startsWith('-') ? scaled.slice(1) : scaled;
}

export function isNegativeDecimal(value: string | number | null | undefined): boolean {
  return toScaled(value, 6).startsWith('-');
}

/** Adds two decimal strings exactly at the given scale. */
export function addDecimals(a: string | number, b: string | number, scale: number): string {
  const sa = toScaled(a, scale);
  const sb = toScaled(b, scale);
  const ia = BigInt(sa.replace('.', ''));
  const ib = BigInt(sb.replace('.', ''));
  const sum = ia + ib;
  const negative = sum < 0n;
  let digits = (negative ? -sum : sum).toString().padStart(scale + 1, '0');
  const intDigits = digits.slice(0, digits.length - scale);
  const fracDigits = digits.slice(digits.length - scale);
  const body = scale > 0 ? `${intDigits}.${fracDigits}` : intDigits;
  return negative ? `-${body}` : body;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** Accepts yyyy-MM-dd or an ISO date-time and returns its yyyy-MM-dd part. */
export function isoDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? '');
  if (!match) {
    throw new Error(`Kein Datum im Format JJJJ-MM-TT: ${value}`);
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function formatDate(value: string, format: DateFormat): string {
  const [y, m, d] = isoDate(value).split('-');
  switch (format) {
    case 'DDMM':
      return `${d}${m}`;
    case 'DDMMYYYY':
      return `${d}${m}${y}`;
    case 'DD.MM.YYYY':
      return `${d}.${m}.${y}`;
    case 'YYYYMMDD':
      return `${y}${m}${d}`;
    case 'YYYY-MM-DD':
      return `${y}-${m}-${d}`;
  }
}

/** First and last day of the month containing the ISO date, both yyyy-MM-dd. */
export function monthBounds(value: string): { from: string; to: string } {
  const [y, m] = isoDate(value).split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, '0')}` };
}

/** Previous calendar month relative to `now` (defaults to today), both yyyy-MM-dd. */
export function previousMonth(now: Date = new Date()): { from: string; to: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-based current month; previous is m-1
  const first = new Date(Date.UTC(y, m - 1, 1));
  return monthBounds(first.toISOString().slice(0, 10));
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export class RecordWriter {
  constructor(readonly profile: FormatProfile) {}

  /** Text cell: quoted per profile, embedded quotes doubled, separators and line breaks neutralised. */
  text(value: string | null | undefined, maxLength?: number): string {
    let v = (value ?? '').replace(/[\r\n]+/g, ' ').trim();
    if (maxLength !== undefined && v.length > maxLength) {
      v = v.slice(0, maxLength);
    }
    if (this.profile.quote) {
      return `${this.profile.quote}${v.split(this.profile.quote).join(this.profile.quote + this.profile.quote)}${this.profile.quote}`;
    }
    return v.split(this.profile.separator).join(' ');
  }

  /** Unquoted number at a fixed scale with the profile's decimal mark. */
  number(value: string | number | null | undefined, scale = 2): string {
    return toScaled(value, scale).replace('.', this.profile.decimalMark);
  }

  /** Unquoted integer. */
  integer(value: number | string | null | undefined): string {
    return toScaled(value ?? 0, 0);
  }

  date(value: string, format: DateFormat = this.profile.dateFormat): string {
    return formatDate(value, format);
  }

  /** Raw cell, written as is. */
  raw(value: string): string {
    return value;
  }

  row(cells: string[]): string {
    return cells.join(this.profile.separator);
  }

  /** Joins rows with the profile line break and terminates the last line. */
  build(rows: string[][]): string {
    return rows.map(r => this.row(r)).join(this.profile.lineBreak) + this.profile.lineBreak;
  }
}

// ---------------------------------------------------------------------------
// Charset encoding and base64 (isolate-safe)
// ---------------------------------------------------------------------------

const CP1252_HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86,
  0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c,
  0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
  0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f
};

/** Encodes to Windows-1252 or ISO-8859-1; unmappable characters become '?'. */
export function encodeSingleByte(text: string, charset: 'windows-1252' | 'iso-8859-1'): Uint8Array {
  const out = new Uint8Array(text.length);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) {
      out[n++] = code;
    } else if (charset === 'windows-1252' && CP1252_HIGH[code] !== undefined) {
      out[n++] = CP1252_HIGH[code];
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // surrogate pair: one replacement for the pair
      out[n++] = 0x3f;
      i++;
    } else {
      out[n++] = 0x3f;
    }
  }
  return out.subarray(0, n);
}

export function encodeText(text: string, charset: Charset): Uint8Array {
  if (charset === 'utf-8') {
    return new TextEncoder().encode(text);
  }
  return encodeSingleByte(text, charset);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x2000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

/** Text in the target charset, base64 encoded, ready for context.files.write. */
export function encodeForFile(text: string, charset: Charset): { content: string; bytes: number } {
  const bytes = encodeText(text, charset);
  return { content: bytesToBase64(bytes), bytes: bytes.length };
}

// ---------------------------------------------------------------------------
// Period guard and warnings
// ---------------------------------------------------------------------------

export class PeriodGuard {
  readonly from: string;
  readonly to: string;

  constructor(from: string, to: string) {
    this.from = isoDate(from);
    this.to = isoDate(to);
    if (this.from > this.to) {
      throw new Error(`Der Zeitraum beginnt (${this.from}) nach seinem Ende (${this.to}).`);
    }
  }

  contains(date: string): boolean {
    const d = isoDate(date);
    return d >= this.from && d <= this.to;
  }

  /** Throws when the date lies outside the declared period. */
  assert(date: string, label: string): void {
    if (!this.contains(date)) {
      throw new Error(`${label}: Datum ${isoDate(date)} liegt außerhalb des Zeitraums ${this.from} bis ${this.to}.`);
    }
  }

  /** Clamps an interval to the period; null when there is no overlap. */
  clamp(start: string, end: string): { start: string; end: string } | null {
    const s = isoDate(start) < this.from ? this.from : isoDate(start);
    const e = isoDate(end) > this.to ? this.to : isoDate(end);
    return s <= e ? { start: s, end: e } : null;
  }
}

export interface ExportWarning {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export class WarningCollector {
  private readonly items: ExportWarning[] = [];

  add(code: string, message: string, details?: Record<string, unknown>): void {
    this.items.push(details ? { code, message, details } : { code, message });
  }

  get count(): number {
    return this.items.length;
  }

  list(): ExportWarning[] {
    return [...this.items];
  }
}

/** Removes characters that are unsafe in object names; keeps the extension. */
export function safeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'export.csv';
}
