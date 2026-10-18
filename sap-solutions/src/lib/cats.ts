import type { Member, TaskDto } from '@timesheet/integration-sdk';
import type { ResolvedConfig } from './types';
import { catsProfile } from './common';
import { employeeKeys, tagTypes, taskUid } from './keys';
import { splitByDay, taskWindow } from './time';
import { ExportWarning, PeriodGuard, RecordWriter, toScaled, WarningCollector } from './writer';

/**
 * Cross-Application Time Sheet (CATS) layout: one row per employee, day, cost object
 * and activity type. Column names follow the S/4HANA Cloud API
 * API_MANAGE_WORKFORCE_TIMESHEET; the docs page maps each to BAPI_CATIMESHEETMGR_INSERT
 * (CATSRECORDS_IN) for on-premise load programs. All three cost object columns are
 * always present so the layout does not change with the configuration.
 */
export const CATS_COLUMNS = [
  'PersonnelNumber',
  'CompanyCode',
  'TimeSheetDate',
  'RecordedHours',
  'WBSElement',
  'ReceiverCostCenter',
  'InternalOrder',
  'ActivityType',
  'TimeSheetNote'
] as const;

/** CATS short text (SHORTTEXT) holds 40 characters. */
const NOTE_LENGTH = 40;

export interface CatsBuildInput {
  tasks: TaskDto[];
  colleagues: Member[];
  mappings: {
    /** user uid to personnel number. Falls back to Member.employeeId. */
    employees: Map<string, string>;
    /** project id to WBS element, cost center or order (per costObjectType). */
    costObjects: Map<string, string>;
    /** tag id to activity type. */
    activityTypes: Map<string, string>;
  };
  config: ResolvedConfig;
  period: PeriodGuard;
}

export interface BuildResult {
  text: string;
  /** Rows written, header excluded. */
  count: number;
  warnings: ExportWarning[];
}

interface Group {
  employee: string;
  date: string;
  costObject: string;
  activityType: string;
  seconds: number;
  notes: string[];
}

export function buildCatsFile(input: CatsBuildInput): BuildResult {
  const { tasks, colleagues, mappings, config: cfg, period } = input;
  const warnings = new WarningCollector();
  const keyOf = employeeKeys(mappings.employees, colleagues, warnings, 'personnel number');
  const activity = tagTypes(mappings.activityTypes, cfg.defaultActivityType);
  const unmappedProjects = new Map<string, string>();
  const groups = new Map<string, Group>();

  for (const task of tasks) {
    const window = taskWindow(task);
    if (!window) continue;
    const shares = splitByDay(window).filter(share => period.contains(share.date));
    if (shares.length === 0) continue;
    const employee = keyOf(taskUid(task), task.member);
    if (!employee) continue;

    const projectId = task.project?.id ?? '';
    const costObject = projectId ? mappings.costObjects.get(projectId) ?? '' : '';
    if (!costObject) {
      unmappedProjects.set(projectId || '(none)', task.project?.title || projectId || '(no project)');
    }
    const activityType = activity.resolve(task);
    const note = (task.description ?? '').replace(/\s+/g, ' ').trim();

    for (const share of shares) {
      const key = [employee, share.date, costObject, activityType, cfg.aggregation === 'task' ? task.id : ''].join('\u0000');
      const group = groups.get(key) ?? { employee, date: share.date, costObject, activityType, seconds: 0, notes: [] };
      group.seconds += share.netSeconds;
      if (note && !group.notes.includes(note)) group.notes.push(note);
      groups.set(key, group);
    }
  }

  for (const [projectId, title] of unmappedProjects) {
    warnings.add('cost-object-unmapped', `Project "${title}" has no ${costObjectLabel(cfg)}. Its rows were exported without one.`, {
      projectId
    });
  }
  activity.report(warnings, 'activity type');

  const rows = [...groups.values()]
    .filter(group => group.seconds > 0)
    .sort(
      (a, b) =>
        a.employee.localeCompare(b.employee) ||
        a.date.localeCompare(b.date) ||
        a.costObject.localeCompare(b.costObject) ||
        a.activityType.localeCompare(b.activityType)
    );

  const writer = new RecordWriter(catsProfile(cfg));
  const out: string[][] = [];
  if (cfg.headerRow) out.push([...CATS_COLUMNS]);
  for (const row of rows) {
    // Keys are never cut: a shortened WBS element or cost center would book onto the
    // wrong object. SAP rejects keys that are too long, which is the safer failure.
    out.push([
      writer.text(row.employee),
      writer.text(cfg.companyCode),
      writer.date(row.date),
      writer.number(toScaled(row.seconds / 3600, 2), 2),
      writer.text(cfg.costObjectType === 'wbs' ? row.costObject : ''),
      writer.text(cfg.costObjectType === 'costCenter' ? row.costObject : ''),
      writer.text(cfg.costObjectType === 'order' ? row.costObject : ''),
      writer.text(row.activityType),
      writer.text(row.notes.join('; '), NOTE_LENGTH)
    ]);
  }

  return { text: out.length > 0 ? writer.build(out) : '', count: rows.length, warnings: warnings.list() };
}

function costObjectLabel(cfg: ResolvedConfig): string {
  switch (cfg.costObjectType) {
    case 'costCenter':
      return 'cost center';
    case 'order':
      return 'internal order';
    default:
      return 'WBS element';
  }
}
