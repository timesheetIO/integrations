import { defineHandler } from '@timesheet/integration-sdk';
import type { ExportResult, SapConfig } from '../lib/types';
import { runExport } from '../lib/runs';

/** Scheduled run on the first of the month: the previous calendar month. */
export const buildMonthly = defineHandler<void, ExportResult, SapConfig>(async (_input, context) => runExport(undefined, context));
