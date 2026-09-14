import { defineHandler } from '@timesheet/integration-sdk';
import { readHistory } from '../lib/common';
import { DatevConfig } from '../lib/types';

export interface HistoryRow {
  at: string;
  surface: string;
  period: string;
  files: string;
  count: number;
  warnings: number;
}

export interface HistoryOutput {
  columns: Array<{ key: keyof HistoryRow; label: string }>;
  items: HistoryRow[];
}

const LABELS: Record<string, string> = { buchungsstapel: 'Buchungsstapel', payroll: 'Lohndaten' };

/** Rows for the history table widget: the last runs recorded by the export handlers. */
export const listHistory = defineHandler<unknown, HistoryOutput, DatevConfig>(async (_input, context) => {
  const history = await readHistory(context);
  return {
    columns: [
      { key: 'at', label: 'Datum' },
      { key: 'surface', label: 'Art' },
      { key: 'period', label: 'Zeitraum' },
      { key: 'files', label: 'Dateien' },
      { key: 'count', label: 'Zeilen' },
      { key: 'warnings', label: 'Hinweise' }
    ],
    items: history.map(run => ({
      at: run.at,
      surface: LABELS[run.surface] ?? run.surface,
      period: `${run.period.from} bis ${run.period.to}`,
      files: run.files.map(f => f.filename).join(', '),
      count: run.count,
      warnings: run.warnings
    }))
  };
});
