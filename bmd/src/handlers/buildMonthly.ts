import { defineHandler } from '@timesheet/integration-sdk';
import type { BmdConfig, ExportSurface, MonthlyResult } from '../lib/types';
import { requireOrganization, resolveConfig } from '../lib/common';
import { runFibuExport, runLohnExport } from '../lib/runs';
import { previousMonth } from '../lib/writer';

/** Scheduled run for the previous calendar month, both surfaces per config. */
export const buildMonthly = defineHandler<void, MonthlyResult, BmdConfig>(async (_input, context) => {
  requireOrganization(context);
  const cfg = resolveConfig(context.config);
  const period = previousMonth();
  const result: MonthlyResult = { period, skipped: [] };
  const skipped: ExportSurface[] = [];

  if (cfg.monthlyFibu) {
    result.fibu = await runFibuExport(period, context);
  } else {
    skipped.push('fibu');
  }
  if (cfg.monthlyLohn) {
    result.lohn = await runLohnExport(period, context);
  } else {
    skipped.push('lohn');
  }
  result.skipped = skipped;
  return result;
});
