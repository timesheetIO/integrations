import type { IntegrationContext, Member, TaskDto, WrittenFile } from '@timesheet/integration-sdk';
import type { ExportResult, PeriodInput, SapConfig } from './types';
import { exportFilename, loadMappingIndex, MAPPING_ENTITY, pageAll, recordRun, resolveConfig, resolvePeriod } from './common';
import { buildCatsFile, BuildResult } from './cats';
import { buildEmployeeTimeFile, buildExternalTimeFile } from './successfactors';
import { taskUid } from './keys';
import { dayBefore } from './time';
import { encodeForFile, ExportWarning, PeriodGuard } from './writer';
import type { Charset } from './writer';

const PAGE = 100;

/**
 * Builds the files for the configured target. Organization installs export every
 * member; profile installs (a consultant booking into a client's CATS) export the
 * installing user only, keyed by the personnel number from the config.
 */
export async function runExport(input: PeriodInput | undefined, context: IntegrationContext<SapConfig>): Promise<ExportResult> {
  const cfg = resolveConfig(context.config);
  const period = resolvePeriod(input);
  const guard = new PeriodGuard(period.from, period.to);
  const isOrg = Boolean(context.organizationId);

  if (cfg.target === 'successfactors' && !isOrg) {
    throw new Error('The SuccessFactors export needs an organization installation. On a personal profile, choose CATS as the target.');
  }

  context.logger.info('SAP export', { installationId: context.installationId, target: cfg.target, ...period });

  const colleagues: Member[] = isOrg
    ? (await context.data.getColleagues({ withoutMe: false, deleted: false, limit: -1 }))?.items ?? []
    : [];
  const userIds = isOrg ? colleagues.map(member => member.uid).filter(Boolean) : [context.userId];

  // One day earlier, so a task that starts the evening before the period and runs
  // past midnight contributes its share inside the period.
  let tasks: TaskDto[] = await pageAll(
    page =>
      context.data.listTasks({
        startDate: dayBefore(period.from),
        endDate: period.to,
        userIds: userIds.length > 0 ? userIds : undefined,
        populatePauses: true,
        populateTags: true,
        populateExpenses: false,
        populateNotes: false,
        page,
        limit: PAGE
      }),
    { firstPage: 1, limit: PAGE }
  );
  if (!isOrg) {
    tasks = tasks.filter(task => taskUid(task) === context.userId);
  }

  const employees = await loadMappingIndex(context, MAPPING_ENTITY.employee);
  if (!isOrg && !employees.has(context.userId)) {
    if (!cfg.personnelNumber) {
      throw new Error('Enter your personnel number from your client’s SAP system in the settings before exporting.');
    }
    employees.set(context.userId, cfg.personnelNumber);
  }
  const typeByTag = await loadMappingIndex(context, MAPPING_ENTITY.activityType);

  const outputs: Array<{ filename: string; build: BuildResult; charset: Charset }> = [];
  if (cfg.target === 'cats') {
    const costObjects = await loadMappingIndex(context, MAPPING_ENTITY.costObject);
    outputs.push({
      filename: exportFilename('CATS', period.from, period.to),
      build: buildCatsFile({ tasks, colleagues, mappings: { employees, costObjects, activityTypes: typeByTag }, config: cfg, period: guard }),
      charset: cfg.charset
    });
  } else {
    outputs.push({
      filename: exportFilename('ExternalTimeData', period.from, period.to),
      build: buildExternalTimeFile({ tasks, colleagues, mappings: { employees, timeTypes: typeByTag }, config: cfg, period: guard }),
      charset: 'utf-8'
    });
    if (cfg.includeAbsences) {
      const [absences, absenceTypes, absenceTimeTypes] = await Promise.all([
        pageAll(
          page => context.data.listAbsences({ startDate: period.from, endDate: period.to, statuses: ['approved'], page, limit: PAGE }),
          { firstPage: 1, limit: PAGE }
        ),
        context.data.listAbsenceTypes({ limit: -1 }),
        loadMappingIndex(context, MAPPING_ENTITY.absenceType)
      ]);
      outputs.push({
        filename: exportFilename('EmployeeTime', period.from, period.to),
        build: buildEmployeeTimeFile({
          absences,
          absenceTypes: absenceTypes?.items ?? [],
          colleagues,
          mappings: { employees, timeTypes: absenceTimeTypes },
          period: guard
        }),
        charset: 'utf-8'
      });
    }
  }

  const files: WrittenFile[] = [];
  const warnings: ExportWarning[] = [];
  let count = 0;
  for (const output of outputs) {
    const encoded = encodeForFile(output.build.text, output.charset);
    const file = await context.files.write({ filename: output.filename, contentType: 'text/csv', content: encoded.content });
    files.push({ ...file, bytes: file.bytes || encoded.bytes });
    warnings.push(...output.build.warnings);
    count += output.build.count;
  }

  await recordRun(context, {
    target: cfg.target,
    from: period.from,
    to: period.to,
    count,
    warningCount: warnings.length,
    files: files.map(file => ({ filename: file.filename, bytes: file.bytes }))
  });
  context.logger.info('SAP export built', { target: cfg.target, rows: count, warnings: warnings.length });
  return { target: cfg.target, period, files, count, warnings };
}
