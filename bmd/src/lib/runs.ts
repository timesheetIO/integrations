import type { IntegrationContext } from '@timesheet/integration-sdk';
import type { BmdConfig, ExportResult, PeriodInput } from './types';
import {
  exportFilename,
  loadMappingIndex,
  MAPPING_ENTITY,
  pageAll,
  recordRun,
  requireOrganization,
  resolveConfig,
  resolvePeriod
} from './common';
import { buildFibuFile } from './fibu';
import { buildLohnFile } from './lohn';
import { encodeForFile, PeriodGuard } from './writer';

const PAGE = 100;

export async function runFibuExport(
  input: PeriodInput | undefined,
  context: IntegrationContext<BmdConfig>
): Promise<ExportResult> {
  const organizationId = requireOrganization(context);
  const cfg = resolveConfig(context.config);
  const period = resolvePeriod(input);
  const guard = new PeriodGuard(period.from, period.to);

  context.logger.info('BMD FIBU export', { installationId: context.installationId, ...period });

  const documents = await pageAll(
    page =>
      context.data.listDocuments({
        organizationId,
        category: 0,
        template: false,
        startDate: period.from,
        endDate: period.to,
        page,
        limit: PAGE
      }),
    { firstPage: 1, limit: PAGE }
  );
  const debtors = await loadMappingIndex(context, MAPPING_ENTITY.customer);

  const build = buildFibuFile({ documents, config: cfg, debtors, period: guard });
  const encoded = encodeForFile(build.text, cfg.charset);
  const file = await context.files.write({
    filename: exportFilename('fibu', period.from, period.to),
    contentType: 'text/csv',
    content: encoded.content
  });

  const result: ExportResult = { surface: 'fibu', period, files: [file], count: build.count, warnings: build.warnings };
  await recordRun(context, {
    surface: 'fibu',
    from: period.from,
    to: period.to,
    count: build.count,
    warningCount: build.warnings.length,
    files: [{ filename: file.filename, bytes: file.bytes || encoded.bytes }]
  });
  return result;
}

export async function runLohnExport(
  input: PeriodInput | undefined,
  context: IntegrationContext<BmdConfig>
): Promise<ExportResult> {
  requireOrganization(context);
  const cfg = resolveConfig(context.config);
  const period = resolvePeriod(input);
  const guard = new PeriodGuard(period.from, period.to);

  context.logger.info('BMD Lohn export', { installationId: context.installationId, ...period });

  const colleagueList = await context.data.getColleagues({ withoutMe: false, deleted: false, limit: -1 });
  const colleagues = colleagueList?.items ?? [];
  const userIds = colleagues.map(member => member.uid).filter(Boolean);

  const [tasks, balances, absences, expenses, absenceTypeList] = await Promise.all([
    pageAll(
      page =>
        context.data.listTasks({
          startDate: period.from,
          endDate: period.to,
          userIds: userIds.length > 0 ? userIds : undefined,
          page,
          limit: PAGE
        }),
      { firstPage: 1, limit: PAGE }
    ),
    pageAll(
      page => context.data.listOvertimeBalances({ startDate: period.from, endDate: period.to, page, limit: PAGE }),
      { firstPage: 0, limit: PAGE }
    ),
    pageAll(
      page =>
        context.data.listAbsences({
          startDate: period.from,
          endDate: period.to,
          statuses: ['approved'],
          page,
          limit: PAGE
        }),
      { firstPage: 1, limit: PAGE }
    ),
    cfg.taggeldKeyword || cfg.naechtigungsgeldKeyword
      ? pageAll(page => context.data.listExpenses({ startDate: period.from, endDate: period.to, page, limit: PAGE }), {
          firstPage: 1,
          limit: PAGE
        })
      : Promise.resolve([]),
    context.data.listAbsenceTypes({ limit: -1 })
  ]);

  const [employees, wageTypes, surcharges] = await Promise.all([
    loadMappingIndex(context, MAPPING_ENTITY.employee),
    loadMappingIndex(context, MAPPING_ENTITY.absenceType),
    loadMappingIndex(context, MAPPING_ENTITY.surchargeType)
  ]);

  const build = buildLohnFile({
    sources: { tasks, balances, absences, expenses, colleagues, absenceTypes: absenceTypeList?.items ?? [] },
    mappings: { employees, wageTypes, surcharges },
    config: cfg,
    period: guard
  });
  const encoded = encodeForFile(build.text, cfg.charset);
  const file = await context.files.write({
    filename: exportFilename('lohn', period.from, period.to),
    contentType: 'text/csv',
    content: encoded.content
  });

  const result: ExportResult = { surface: 'lohn', period, files: [file], count: build.count, warnings: build.warnings };
  await recordRun(context, {
    surface: 'lohn',
    from: period.from,
    to: period.to,
    count: build.count,
    warningCount: build.warnings.length,
    files: [{ filename: file.filename, bytes: file.bytes || encoded.bytes }]
  });
  return result;
}
