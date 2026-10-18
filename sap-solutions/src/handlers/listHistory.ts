import { defineHandler } from '@timesheet/integration-sdk';
import type { HistoryEntry, SapConfig } from '../lib/types';
import { HISTORY_KEY, TARGET_LABELS } from '../lib/common';

export interface HistoryRow {
  at: string;
  target: string;
  period: string;
  files: string;
  count: number;
  warnings: number;
}

export interface HistoryOutput {
  columns: Array<{ key: keyof HistoryRow; label: string }>;
  items: HistoryRow[];
}

/**
 * Rows for the history table widget: the last runs recorded by the export handlers.
 * Download links expire, so only metadata is kept. `at` stays ISO; the web formats it
 * in the viewer's locale and time zone.
 */
export const listHistory = defineHandler<void, HistoryOutput, SapConfig>(async (_input, context) => {
  const stored = (await context.state.get<HistoryEntry[]>(HISTORY_KEY)) ?? [];
  const history = Array.isArray(stored) ? stored : [];
  return {
    columns: [
      { key: 'at', label: 'Date' },
      { key: 'target', label: 'Target' },
      { key: 'period', label: 'Period' },
      { key: 'files', label: 'Files' },
      { key: 'count', label: 'Rows' },
      { key: 'warnings', label: 'Notes' }
    ],
    items: history.map(run => ({
      at: run.at,
      target: TARGET_LABELS[run.target] ?? run.target,
      period: `${run.from} to ${run.to}`,
      files: (run.files ?? []).map(f => f.filename).join(', '),
      count: run.count,
      warnings: run.warningCount
    }))
  };
});
