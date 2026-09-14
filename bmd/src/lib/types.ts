import type { WrittenFile } from '@timesheet/integration-sdk';
import type { Charset, DateFormat, ExportWarning } from './writer';

export type SeparatorOption = ';' | ',' | 'tab' | '|';
export type GutschriftModus = 'buchcode' | 'negativ';

/** Raw installation config as declared in manifest.json configSchema. */
export interface BmdConfig {
  firmennummer?: string;
  mandantennummer?: string;
  buchungssymbol?: string;
  erloeskonto20?: string;
  erloeskonto10?: string;
  erloeskonto13?: string;
  erloeskontoSteuerfrei?: string;
  erloeskontoReverseCharge?: string;
  steuercode20?: string;
  steuercode10?: string;
  steuercode13?: string;
  steuercodeSteuerfrei?: string;
  steuercodeReverseCharge?: string;
  debitorStandard?: string;
  gutschriftModus?: GutschriftModus;
  kostenstelle?: string;
  filiale?: string;
  charset?: Charset;
  separator?: SeparatorOption;
  decimalMark?: ',' | '.';
  dateFormat?: DateFormat;
  headerRow?: boolean;
  quoteText?: boolean;
  taggeldKeyword?: string;
  naechtigungsgeldKeyword?: string;
  monthlyFibu?: boolean;
  monthlyLohn?: boolean;
}

export interface ResolvedConfig {
  firmennummer: string;
  mandantennummer: string;
  buchungssymbol: string;
  erloeskonto20: string;
  erloeskonto10: string;
  erloeskonto13: string;
  erloeskontoSteuerfrei: string;
  erloeskontoReverseCharge: string;
  steuercode20: string;
  steuercode10: string;
  steuercode13: string;
  steuercodeSteuerfrei: string;
  steuercodeReverseCharge: string;
  debitorStandard: string;
  gutschriftModus: GutschriftModus;
  kostenstelle: string;
  filiale: string;
  charset: Charset;
  separator: string;
  decimalMark: ',' | '.';
  dateFormat: DateFormat;
  headerRow: boolean;
  quoteText: boolean;
  taggeldKeyword: string;
  naechtigungsgeldKeyword: string;
  monthlyFibu: boolean;
  monthlyLohn: boolean;
}

export interface PeriodInput {
  /** yyyy-MM-dd, inclusive. Defaults to the first day of the previous month. */
  from?: string;
  /** yyyy-MM-dd, inclusive. Defaults to the last day of the previous month. */
  to?: string;
}

export type ExportSurface = 'fibu' | 'lohn';

export interface ExportResult {
  surface: ExportSurface;
  period: { from: string; to: string };
  files: WrittenFile[];
  /** FIBU: exported invoices. Lohn: exported lines. */
  count: number;
  warnings: ExportWarning[];
}

export interface MonthlyResult {
  period: { from: string; to: string };
  fibu?: ExportResult;
  lohn?: ExportResult;
  skipped: ExportSurface[];
}

export interface HistoryEntry {
  id: string;
  at: string;
  surface: ExportSurface;
  from: string;
  to: string;
  count: number;
  warningCount: number;
  files: Array<{ filename: string; bytes: number }>;
}

export interface EntityListResult {
  items: Array<{ id: string; name: string }>;
}
