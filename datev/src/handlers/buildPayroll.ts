import { defineHandler, WrittenFile } from '@timesheet/integration-sdk';
import { nowIso, recordRun, requireOrganization, resolveConfig, resolvePeriod } from '../lib/common';
import { buildLodasBewegungsdaten, buildLodasStammdaten, lodasFilenames } from '../lib/lodas';
import { buildLugBewegungsdaten, lugFilename } from '../lib/lug';
import { collectPayrollFacts } from '../lib/payroll';
import { DatevConfig, ExportResult, PeriodInput } from '../lib/types';
import { WarningCollector, encodeForFile, monthBounds } from '../lib/writer';

export const buildPayroll = defineHandler<PeriodInput | undefined, ExportResult, DatevConfig>(async (input, context) => {
  const organizationId = requireOrganization(context);
  const config = resolveConfig(context.config);
  const period = resolvePeriod(input);
  // LODAS and Lohn und Gehalt book every line on one Abrechnungsmonat.
  if (period.to > monthBounds(period.from).to) {
    throw new Error(
      `Lohndaten werden pro Abrechnungsmonat erzeugt. Der Zeitraum ${period.from} bis ${period.to} umfasst mehrere Monate; bitte einen Zeitraum innerhalb eines Kalendermonats wählen.`
    );
  }
  const warnings = new WarningCollector();

  context.logger.info('Building DATEV payroll export', { organizationId, period, target: config.payrollTarget });

  const facts = await collectPayrollFacts(context, config, period, warnings);
  const employees = facts.employees.filter(e => e.lines.length > 0);
  const count = employees.reduce((sum, e) => sum + e.lines.length, 0);

  const outputs: Array<{ filename: string; text: string }> = [];
  if (config.payrollTarget === 'LODAS') {
    const names = lodasFilenames(period);
    outputs.push({ filename: names.stammdaten, text: buildLodasStammdaten(employees, config) });
    outputs.push({ filename: names.bewegungsdaten, text: buildLodasBewegungsdaten(employees, config, period) });
  } else {
    outputs.push({ filename: lugFilename(period), text: buildLugBewegungsdaten(employees, config, period) });
  }

  const files: WrittenFile[] = [];
  for (const output of outputs) {
    const encoded = encodeForFile(output.text, 'windows-1252');
    const file = await context.files.write({ filename: output.filename, contentType: 'text/plain', content: encoded.content });
    files.push({ ...file, bytes: file.bytes || encoded.bytes });
  }

  const createdAt = new Date();
  const result: ExportResult = { surface: 'payroll', period, files, count, warnings: warnings.list() };
  await recordRun(context, {
    at: nowIso(createdAt),
    surface: 'payroll',
    period,
    files: files.map(f => ({ filename: f.filename, bytes: f.bytes })),
    count,
    warnings: warnings.count
  });
  context.logger.info('DATEV payroll export built', { employees: employees.length, lines: count, warnings: warnings.count });
  return result;
});
