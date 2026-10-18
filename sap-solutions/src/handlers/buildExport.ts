import { defineHandler } from '@timesheet/integration-sdk';
import type { ExportResult, PeriodInput, SapConfig } from '../lib/types';
import { runExport } from '../lib/runs';

/** Builds the import file(s) for the configured SAP target and period. */
export const buildExport = defineHandler<PeriodInput, ExportResult, SapConfig>(async (input, context) => runExport(input, context));
