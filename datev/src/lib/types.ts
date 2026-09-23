import type { WrittenFile } from '@timesheet/integration-sdk';
import type { ExportWarning } from './writer';

export type Skr = 'SKR03' | 'SKR04';
export type PayrollTarget = 'LODAS' | 'LUG';
export type DatevCharset = 'windows-1252' | 'utf-8';

/** Raw configuration as stored by the web; every field may be missing. */
export interface DatevConfig {
  beraternummer?: string;
  mandantennummer?: string;
  skr?: Skr;
  sachkontenlaenge?: number | string;
  wirtschaftsjahrBeginn?: string;
  formatVersion?: string;
  charset?: DatevCharset;
  festschreibung?: boolean;
  steuersatzStandard?: string;
  steuersatzErmaessigt?: string;
  erloeskontoStandard?: string;
  erloeskontoErmaessigt?: string;
  erloeskontoSteuerfrei?: string;
  erloeskontoReverseCharge?: string;
  debitorStandard?: string;
  payrollTarget?: PayrollTarget;
  mandantLohn?: string;
  lohnartArbeitsstunden?: string;
  lohnartUeberstunden?: string;
  lohnartMinderstunden?: string;
  verpflegungKeyword?: string;
  uebernachtungKeyword?: string;
  lohnartVerpflegung?: string;
  lohnartUebernachtung?: string;
  customerWindowMonths?: number | string;
  monthlyBuchungsstapel?: boolean;
  monthlyLohn?: boolean;
}

/** Configuration with every default applied. */
export interface ResolvedConfig {
  beraternummer: string;
  mandantennummer: string;
  skr: Skr;
  sachkontenlaenge: number;
  wirtschaftsjahrBeginn: { day: number; month: number };
  formatVersion: string;
  charset: DatevCharset;
  festschreibung: boolean;
  steuersatzStandard: string;
  steuersatzErmaessigt: string;
  erloeskontoStandard: string;
  erloeskontoErmaessigt: string;
  erloeskontoSteuerfrei: string;
  erloeskontoReverseCharge: string;
  debitorStandard: string;
  payrollTarget: PayrollTarget;
  mandantLohn: string;
  lohnartArbeitsstunden: string;
  lohnartUeberstunden: string;
  lohnartMinderstunden: string;
  verpflegungKeyword: string;
  uebernachtungKeyword: string;
  lohnartVerpflegung: string;
  lohnartUebernachtung: string;
  customerWindowMonths: number;
  monthlyBuchungsstapel: boolean;
  monthlyLohn: boolean;
}

export interface PeriodInput {
  from?: string;
  to?: string;
}

export interface Period {
  from: string;
  to: string;
}

export type Surface = 'buchungsstapel' | 'payroll';

export interface ExportResult {
  surface: Surface;
  period: Period;
  files: WrittenFile[];
  count: number;
  warnings: ExportWarning[];
}

export interface RunRecord {
  at: string;
  surface: Surface;
  period: Period;
  files: Array<{ filename: string; bytes: number }>;
  count: number;
  warnings: number;
}

export const SYSTEM = 'datev';
export const HISTORY_KEY = 'history';
export const HISTORY_LIMIT = 12;
