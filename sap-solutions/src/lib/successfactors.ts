import type { AbsenceDto, AbsenceTypeDto, Member, TaskDto } from '@timesheet/integration-sdk';
import type { ResolvedConfig } from './types';
import { memberName, SUCCESSFACTORS_PROFILE } from './common';
import type { BuildResult } from './cats';
import { employeeKeys, tagTypes, taskUid } from './keys';
import { splitByDay, taskWindow, to12h, usDate, wallDate, wallTime } from './time';
import { isoDate, PeriodGuard, RecordWriter, toScaled, WarningCollector } from './writer';

/**
 * Generic object "External Time Data" (Admin Center, Import and Export Data). Columns
 * as documented in "Filling In the Template for External Time Data"; confirm against
 * the template downloaded from the customer's tenant. userId and startDate are the
 * key. Duration recorders get `hours`, clock-time recorders `startTime`/`endTime`.
 */
export const EXTERNAL_TIME_COLUMNS = ['userId', 'startDate', 'endDate', 'startTime', 'endTime', 'hours', 'timeType', 'category'] as const;

/** Generic object "Employee Time" (Time Off). SAP prescribes MM/DD/YYYY for its dates. */
export const EMPLOYEE_TIME_COLUMNS = [
  'externalCode',
  'userId',
  'timeType',
  'startDate',
  'endDate',
  'approvalStatus',
  'fractionQuantity'
] as const;

export interface ExternalTimeInput {
  tasks: TaskDto[];
  colleagues: Member[];
  mappings: {
    /** user uid to SuccessFactors user ID. Falls back to Member.employeeId. */
    employees: Map<string, string>;
    /** tag id to SuccessFactors attendance time type. */
    timeTypes: Map<string, string>;
  };
  config: ResolvedConfig;
  period: PeriodGuard;
}

export function buildExternalTimeFile(input: ExternalTimeInput): BuildResult {
  const { tasks, colleagues, mappings, config: cfg, period } = input;
  const warnings = new WarningCollector();
  const keyOf = employeeKeys(mappings.employees, colleagues, warnings, 'SuccessFactors user ID');
  const timeTypes = tagTypes(mappings.timeTypes, cfg.defaultTimeType);
  const writer = new RecordWriter(SUCCESSFACTORS_PROFILE);
  const time = (value: string) => (cfg.clockFormat === '12h' ? to12h(value) : value);
  const category = (timeType: string) => (timeType ? '' : 'Attendance');

  const rows: string[][] = [];
  let crossMidnight = 0;
  let missingBreaks = 0;

  if (cfg.timeMode === 'clock') {
    const sorted: Array<{ key: string; date: string; start: string; cells: string[] }> = [];
    for (const task of tasks) {
      const window = taskWindow(task);
      if (!window) continue;
      const startDate = wallDate(window.start);
      if (!period.contains(startDate)) continue;
      const userId = keyOf(taskUid(task), task.member);
      if (!userId) continue;
      const endDate = wallDate(window.end);
      if (endDate !== startDate) crossMidnight++;
      const timeType = timeTypes.resolve(task);
      sorted.push({
        key: userId,
        date: startDate,
        start: wallTime(window.start),
        cells: [
          writer.text(userId),
          usDate(startDate),
          endDate !== startDate ? usDate(endDate) : '',
          time(wallTime(window.start)),
          time(wallTime(window.end)),
          '',
          writer.text(timeType),
          category(timeType)
        ]
      });
      if (window.breaksEstimated) missingBreaks++;
      for (const pause of window.breaks) {
        const pauseDate = wallDate(pause.start);
        const pauseEnd = wallDate(pause.end);
        sorted.push({
          key: userId,
          date: pauseDate,
          start: wallTime(pause.start),
          cells: [
            writer.text(userId),
            usDate(pauseDate),
            pauseEnd !== pauseDate ? usDate(pauseEnd) : '',
            time(wallTime(pause.start)),
            time(wallTime(pause.end)),
            '',
            '',
            'Break'
          ]
        });
      }
    }
    sorted.sort((a, b) => a.key.localeCompare(b.key) || a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
    rows.push(...sorted.map(item => item.cells));
  } else {
    const groups = new Map<string, { userId: string; date: string; timeType: string; seconds: number }>();
    for (const task of tasks) {
      const window = taskWindow(task);
      if (!window) continue;
      const shares = splitByDay(window).filter(share => period.contains(share.date));
      if (shares.length === 0) continue;
      const userId = keyOf(taskUid(task), task.member);
      if (!userId) continue;
      const timeType = timeTypes.resolve(task);
      for (const share of shares) {
        const key = [userId, share.date, timeType].join('\u0000');
        const group = groups.get(key) ?? { userId, date: share.date, timeType, seconds: 0 };
        group.seconds += share.netSeconds;
        groups.set(key, group);
      }
    }
    const sorted = [...groups.values()]
      .filter(group => group.seconds > 0)
      .sort((a, b) => a.userId.localeCompare(b.userId) || a.date.localeCompare(b.date) || a.timeType.localeCompare(b.timeType));
    for (const group of sorted) {
      rows.push([
        writer.text(group.userId),
        usDate(group.date),
        '',
        '',
        '',
        writer.number(toScaled(group.seconds / 3600, 2), 2),
        writer.text(group.timeType),
        category(group.timeType)
      ]);
    }
  }

  if (crossMidnight > 0) {
    warnings.add(
      'cross-midnight',
      `${crossMidnight} task(s) run past midnight and carry an endDate. SuccessFactors imports these only with the Time Tracking subscription.`
    );
  }
  if (missingBreaks > 0) {
    warnings.add('breaks-missing', `${missingBreaks} task(s) have break time but no break times of day, so no Break rows were written for them.`);
  }
  timeTypes.report(warnings, 'time type');

  const out: string[][] = [[...EXTERNAL_TIME_COLUMNS], ...rows];
  return { text: writer.build(out), count: rows.length, warnings: warnings.list() };
}

export interface EmployeeTimeInput {
  absences: AbsenceDto[];
  absenceTypes: AbsenceTypeDto[];
  colleagues: Member[];
  mappings: {
    employees: Map<string, string>;
    /** absence type id to SuccessFactors time type. */
    timeTypes: Map<string, string>;
  };
  period: PeriodGuard;
}

/**
 * Approved absences that start in the period, one row each with the full absence
 * dates. The Timesheet absence id is the externalCode, so importing the same absence
 * again updates it instead of creating a second leave.
 */
export function buildEmployeeTimeFile(input: EmployeeTimeInput): BuildResult {
  const { absences, absenceTypes, colleagues, mappings, period } = input;
  const warnings = new WarningCollector();
  const keyOf = employeeKeys(mappings.employees, colleagues, warnings, 'SuccessFactors user ID');
  const writer = new RecordWriter(SUCCESSFACTORS_PROFILE);
  const typeNames = new Map<string, string>();
  for (const type of absenceTypes) typeNames.set(type.id, type.name || type.code || type.id);
  const unmappedTypes = new Set<string>();

  const rows: Array<{ userId: string; start: string; cells: string[] }> = [];
  for (const absence of absences) {
    if ((absence.status ?? 'approved').toLowerCase() !== 'approved') continue;
    const start = isoDate(absence.startDateTime);
    const end = isoDate(absence.endDateTime);
    if (!period.contains(start)) continue;
    const typeId = absence.absenceTypeId || absence.absenceType?.id || '';
    const timeType = mappings.timeTypes.get(typeId);
    if (!timeType) {
      if (!unmappedTypes.has(typeId)) {
        unmappedTypes.add(typeId);
        const name = absence.absenceType?.name || typeNames.get(typeId) || typeId || '(unknown)';
        warnings.add('absence-type-unmapped', `Absence type "${name}" has no SuccessFactors time type. Its absences were skipped.`, {
          absenceTypeId: typeId
        });
      }
      continue;
    }
    const uid = absence.member?.uid ?? '';
    const userId = uid ? keyOf(uid, absence.member) : null;
    if (!userId) continue;

    // SuccessFactors takes a fraction only for a single day.
    let fraction = '';
    if (absence.fullDay === false && start === end && absence.totalHours) {
      fraction = decimalHours(absence.totalHours);
    } else if (absence.fullDay === false) {
      warnings.add('fraction-multi-day', `A part-day absence of ${memberName(absence.member, uid)} spans several days and was exported as full days.`, {
        absenceId: absence.id
      });
    }
    rows.push({
      userId,
      start,
      cells: [
        writer.text(`timesheet-${absence.id}`),
        writer.text(userId),
        writer.text(timeType),
        usDate(start),
        usDate(end),
        'APPROVED',
        fraction
      ]
    });
  }
  rows.sort((a, b) => a.userId.localeCompare(b.userId) || a.start.localeCompare(b.start));
  const out: string[][] = [[...EMPLOYEE_TIME_COLUMNS], ...rows.map(row => row.cells)];
  return { text: writer.build(out), count: rows.length, warnings: warnings.list() };
}

/** Decimal hours with up to 10 places and no trailing zeros, as SAP asks for fractions. */
function decimalHours(value: string): string {
  return toScaled(value, 10).replace(/\.?0+$/, '');
}
