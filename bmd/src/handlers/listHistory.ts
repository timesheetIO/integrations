import { defineHandler } from '@timesheet/integration-sdk';
import type { BmdConfig, HistoryEntry } from '../lib/types';
import { HISTORY_KEY } from '../lib/common';

/** The last runs for the history table. Download links expire, so only metadata is kept. */
export const listHistory = defineHandler<void, { items: HistoryEntry[] }, BmdConfig>(async (_input, context) => {
  const items = (await context.state.get<HistoryEntry[]>(HISTORY_KEY)) ?? [];
  return { items: Array.isArray(items) ? items : [] };
});
