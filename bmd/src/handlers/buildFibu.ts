import { defineHandler } from '@timesheet/integration-sdk';
import type { BmdConfig, ExportResult, PeriodInput } from '../lib/types';
import { runFibuExport } from '../lib/runs';

/** Builds the BMD NTCS FIBU Buchungsimport for the outgoing invoices of a period. */
export const buildFibu = defineHandler<PeriodInput, ExportResult, BmdConfig>(
  async (input, context) => runFibuExport(input, context)
);
