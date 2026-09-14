import { defineHandler } from '@timesheet/integration-sdk';
import { requireOrganization, resolveConfig } from '../lib/common';
import { DatevConfig, ExportResult } from '../lib/types';
import { previousMonth } from '../lib/writer';
import { buildBuchungsstapel } from './buildBuchungsstapel';
import { buildPayroll } from './buildPayroll';

export interface MonthlyResult {
  period: { from: string; to: string };
  results: ExportResult[];
}

/** Scheduled on the first of the month: exports the previous month for every enabled surface. */
export const buildMonthly = defineHandler<unknown, MonthlyResult, DatevConfig>(async (_input, context) => {
  requireOrganization(context);
  const config = resolveConfig(context.config);
  const period = previousMonth();
  const results: ExportResult[] = [];
  if (config.monthlyBuchungsstapel) {
    results.push(await buildBuchungsstapel(period, context));
  }
  if (config.monthlyLohn) {
    results.push(await buildPayroll(period, context));
  }
  return { period, results };
});
