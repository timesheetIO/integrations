import { defineHandler } from '@timesheet/integration-sdk';
import type { BmdConfig, ExportSurface, HistoryEntry } from '../lib/types';
import { HISTORY_KEY } from '../lib/common';
import { formatDate } from '../lib/writer';

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

const LABELS: Record<ExportSurface, string> = { fibu: 'FIBU-Import', lohn: 'Lohnimport' };

/**
 * Rows for the history table widget: the last runs recorded by the export handlers.
 * Download links expire, so only metadata is kept. `at` stays ISO; the web formats it
 * in the viewer's locale and time zone.
 */
export const listHistory = defineHandler<void, HistoryOutput, BmdConfig>(async (_input, context) => {
  const stored = (await context.state.get<HistoryEntry[]>(HISTORY_KEY)) ?? [];
  const history = Array.isArray(stored) ? stored : [];
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
      period: `${formatDate(run.from, 'DD.MM.YYYY')} bis ${formatDate(run.to, 'DD.MM.YYYY')}`,
      files: (run.files ?? []).map(f => f.filename).join(', '),
      count: run.count,
      warnings: run.warningCount
    }))
  };
});
