import { defineHandler } from '@timesheet/integration-sdk';
import type { BmdConfig, ExportResult, PeriodInput } from '../lib/types';
import { runLohnExport } from '../lib/runs';

/** Builds the BMD NTCS Lohn import for a period: worked time, overtime, absences, allowances. */
export const buildLohn = defineHandler<PeriodInput, ExportResult, BmdConfig>(
  async (input, context) => runLohnExport(input, context)
);
