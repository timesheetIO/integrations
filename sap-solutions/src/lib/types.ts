import type { WrittenFile } from '@timesheet/integration-sdk';
import type { Charset, DateFormat, ExportWarning } from './writer';

export type Target = 'cats' | 'successfactors';
export type CostObjectType = 'wbs' | 'costCenter' | 'order';
export type Aggregation = 'day' | 'task';
export type TimeMode = 'duration' | 'clock';
export type ClockFormat = '24h' | '12h';
export type SeparatorOption = ';' | ',' | 'tab' | '|';

/** Raw installation config as declared in manifest.json configSchema. */
export interface SapConfig {
  target?: Target;
  personnelNumber?: string;
  companyCode?: string;
  costObjectType?: CostObjectType;
  defaultActivityType?: string;
  aggregation?: Aggregation;
  timeMode?: TimeMode;
  defaultTimeType?: string;
  clockFormat?: ClockFormat;
  includeAbsences?: boolean;
  separator?: SeparatorOption;
  decimalMark?: ',' | '.';
  dateFormat?: DateFormat;
  charset?: Charset;
  headerRow?: boolean;
  quoteText?: boolean;
}

export interface ResolvedConfig {
  target: Target;
  personnelNumber: string;
  companyCode: string;
  costObjectType: CostObjectType;
  defaultActivityType: string;
  aggregation: Aggregation;
  timeMode: TimeMode;
  defaultTimeType: string;
  clockFormat: ClockFormat;
  includeAbsences: boolean;
  separator: string;
  decimalMark: ',' | '.';
  dateFormat: DateFormat;
  charset: Charset;
  headerRow: boolean;
  quoteText: boolean;
}

export interface PeriodInput {
  /** yyyy-MM-dd, inclusive. Defaults to the first day of the previous month. */
  from?: string;
  /** yyyy-MM-dd, inclusive. Defaults to the last day of the previous month. */
  to?: string;
}

export interface ExportResult {
  target: Target;
  period: { from: string; to: string };
  files: WrittenFile[];
  /** Rows written across all files, header rows excluded. */
  count: number;
  warnings: ExportWarning[];
}

export interface HistoryEntry {
  id: string;
  at: string;
  target: Target;
  from: string;
  to: string;
  count: number;
  warningCount: number;
  files: Array<{ filename: string; bytes: number }>;
}

export interface EntityListResult {
  items: Array<{ id: string; name: string }>;
}
