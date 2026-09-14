import type { AbsenceDto, AbsenceTypeDto, ExpenseDto, Member, OvertimeBalanceDto, TaskDto } from '@timesheet/integration-sdk';
import type { ResolvedConfig } from './types';
import { memberName, profileFromConfig } from './common';
import { addDecimals, ExportWarning, isoDate, PeriodGuard, RecordWriter, toScaled, WarningCollector } from './writer';

/**
 * BMD NTCS Lohn import, one line per employee, wage type and period (worked time,
 * overtime, allowances) or per absence (own dates). Column order lives here only.
 */
export const LOHN_COLUMNS = [
  'firmennr',
  'dienstverhaeltnisnr',
  'lohnart',
  'datum_von',
  'datum_bis',
  'stunden',
  'tage',
  'betrag',
  'text'
] as const;

export interface LohnSources {
  tasks: TaskDto[];
  balances: OvertimeBalanceDto[];
  absences: AbsenceDto[];
  expenses: ExpenseDto[];
  colleagues: Member[];
  absenceTypes: AbsenceTypeDto[];
}

export interface LohnMappings {
  /** user uid to Dienstverhältnisnummer. Falls back to Member.employeeId. */
  employees: Map<string, string>;
  /** absence type id to Lohnart. */
  wageTypes: Map<string, string>;
  /** surcharge type id (see SURCHARGE_TYPES) to Lohnart. */
  surcharges: Map<string, string>;
}

export interface LohnBuildInput {
  sources: LohnSources;
  mappings: LohnMappings;
  config: ResolvedConfig;
  period: PeriodGuard;
}

export interface LohnBuildResult {
  text: string;
  /** Lines written, header excluded. */
  count: number;
  employees: number;
  warnings: ExportWarning[];
}

interface Line {
  employee: string;
  lohnart: string;
  from: string;
  to: string;
  hours: string;
  days: string;
  amount: string;
  text: string;
}

function minutesToHours(minutes: number | undefined | null): string {
  const m = Number(minutes ?? 0);
  if (!Number.isFinite(m) || m <= 0) return '0.00';
  return toScaled(m / 60, 2);
}

function calendarDays(from: string, to: string): number {
  const a = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
  const b = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  return Math.round((b - a) / 86400000) + 1;
}

export function buildLohnFile(input: LohnBuildInput): LohnBuildResult {
  const { sources, mappings, config: cfg, period } = input;
  const warnings = new WarningCollector();
  const colleagues = new Map<string, Member>();
  for (const member of sources.colleagues) {
    colleagues.set(member.uid, member);
  }
  const absenceTypeNames = new Map<string, string>();
  for (const type of sources.absenceTypes) {
    absenceTypeNames.set(type.id, type.name || type.code || type.id);
  }

  const unmappedEmployees = new Set<string>();
  const unmappedLohnarten = new Set<string>();

  const employeeNumber = (uid: string, member?: Member): string | null => {
    const mapped = mappings.employees.get(uid);
    if (mapped) return mapped;
    const fallback = (member ?? colleagues.get(uid))?.employeeId?.trim();
    if (fallback) return fallback;
    if (!unmappedEmployees.has(uid)) {
      unmappedEmployees.add(uid);
      warnings.add('employee-unmapped', `Mitarbeiter "${memberName(member ?? colleagues.get(uid), uid)}" hat keine Dienstverhältnisnummer, Zeilen übersprungen.`, {
        userId: uid
      });
    }
    return null;
  };

  const surchargeLohnart = (id: string, label: string): string | null => {
    const lohnart = mappings.surcharges.get(id);
    if (lohnart) return lohnart;
    if (!unmappedLohnarten.has(`surcharge:${id}`)) {
      unmappedLohnarten.add(`surcharge:${id}`);
      warnings.add('lohnart-unmapped', `Für "${label}" ist keine BMD Lohnart zugeordnet, Zeilen übersprungen.`, { surchargeType: id });
    }
    return null;
  };

  const lines: Line[] = [];
  const employeesSeen = new Set<string>();
  const push = (line: Line) => {
    lines.push(line);
    employeesSeen.add(line.employee);
  };

  // Worked time from tasks, per employee.
  const workedSeconds = new Map<string, number>();
  for (const task of sources.tasks) {
    if (task.running || task.deleted) continue;
    if (!task.startDateTime || !period.contains(task.startDateTime)) continue;
    const net = Number(task.duration ?? 0) - Number(task.durationBreak ?? 0);
    if (!Number.isFinite(net) || net <= 0) continue;
    const uid = task.member?.uid || task.user;
    workedSeconds.set(uid, (workedSeconds.get(uid) ?? 0) + net);
  }
  if (workedSeconds.size > 0) {
    const lohnart = surchargeLohnart('normalstunden', 'Normalstunden');
    if (lohnart) {
      for (const [uid, seconds] of workedSeconds) {
        const number = employeeNumber(uid);
        if (!number) continue;
        push({
          employee: number,
          lohnart,
          from: period.from,
          to: period.to,
          hours: toScaled(seconds / 3600, 2),
          days: '',
          amount: '',
          text: 'Normalstunden'
        });
      }
    }
  }

  // Overtime and surcharges from balances, per employee.
  const overtime = new Map<string, Map<string, number>>();
  const addOvertime = (uid: string, type: string, minutes: number | undefined | null) => {
    const m = Number(minutes ?? 0);
    if (!Number.isFinite(m) || m <= 0) return;
    const per = overtime.get(uid) ?? new Map<string, number>();
    per.set(type, (per.get(type) ?? 0) + m);
    overtime.set(uid, per);
  };
  for (const balance of sources.balances) {
    if (!balance.periodStart || !period.contains(balance.periodStart)) continue;
    const uid = balance.member?.uid;
    if (!uid) continue;
    const hasTiers = balance.overtimeTier1Minutes !== undefined || balance.overtimeTier2Minutes !== undefined;
    if (hasTiers) {
      addOvertime(uid, 'ueberstunden-50', balance.overtimeTier1Minutes);
      addOvertime(uid, 'ueberstunden-100', balance.overtimeTier2Minutes);
    } else {
      addOvertime(uid, 'ueberstunden-50', balance.overtimeMinutes);
    }
    addOvertime(uid, 'nachtarbeit', balance.nightMinutes);
    addOvertime(uid, 'sonntagsarbeit', balance.weekendMinutes);
    addOvertime(uid, 'feiertagsarbeit', balance.holidayMinutes);
  }
  const surchargeLabels: Record<string, string> = {
    'ueberstunden-50': 'Überstunden 50 %',
    'ueberstunden-100': 'Überstunden 100 %',
    nachtarbeit: 'Nachtarbeit',
    sonntagsarbeit: 'Sonntagsarbeit',
    feiertagsarbeit: 'Feiertagsarbeit'
  };
  for (const [uid, per] of overtime) {
    const number = employeeNumber(uid);
    if (!number) continue;
    for (const type of Object.keys(surchargeLabels)) {
      const minutes = per.get(type);
      if (!minutes) continue;
      const lohnart = surchargeLohnart(type, surchargeLabels[type]);
      if (!lohnart) continue;
      push({
        employee: number,
        lohnart,
        from: period.from,
        to: period.to,
        hours: minutesToHours(minutes),
        days: '',
        amount: '',
        text: surchargeLabels[type]
      });
    }
  }

  // Absences, one line each with its own dates, clamped to the period.
  for (const absence of sources.absences) {
    const uid = absence.member?.uid;
    if (!uid) continue;
    const typeId = absence.absenceTypeId || absence.absenceType?.id || '';
    const typeName = absence.absenceType?.name || absenceTypeNames.get(typeId) || typeId || '(unbekannt)';
    const lohnart = mappings.wageTypes.get(typeId);
    if (!lohnart) {
      if (!unmappedLohnarten.has(`absence:${typeId}`)) {
        unmappedLohnarten.add(`absence:${typeId}`);
        warnings.add('lohnart-unmapped', `Für die Abwesenheitsart "${typeName}" ist keine BMD Lohnart zugeordnet, Abwesenheiten übersprungen.`, {
          absenceTypeId: typeId
        });
      }
      continue;
    }
    const number = employeeNumber(uid, absence.member);
    if (!number) continue;
    const start = isoDate(absence.startDateTime);
    const end = isoDate(absence.endDateTime);
    const clamped = period.clamp(start, end);
    if (!clamped) continue;
    let days: string;
    let hours = '';
    if (clamped.start !== start || clamped.end !== end) {
      days = toScaled(calendarDays(clamped.start, clamped.end), 2);
      warnings.add('absence-clamped', `Abwesenheit von ${memberName(absence.member, uid)} (${typeName}) reicht über den Zeitraum hinaus, nur der Teil im Zeitraum wurde als Kalendertage exportiert.`, {
        absenceId: absence.id,
        userId: uid
      });
    } else {
      days = toScaled(absence.totalDays ?? calendarDays(start, end), 2);
      if (absence.fullDay === false && absence.totalHours) {
        hours = toScaled(absence.totalHours, 2);
      }
    }
    push({
      employee: number,
      lohnart,
      from: clamped.start,
      to: clamped.end,
      hours,
      days,
      amount: '',
      text: typeName
    });
  }

  // Allowances from expenses by keyword, per employee.
  const allowance = (keyword: string, surchargeId: string, label: string) => {
    if (!keyword) return;
    const needle = keyword.toLowerCase();
    const sums = new Map<string, string>();
    for (const expense of sources.expenses) {
      if (expense.deleted) continue;
      if (expense.dateTime && !period.contains(expense.dateTime)) continue;
      const haystack = (expense.description ?? '').toLowerCase();
      if (!haystack.includes(needle)) continue;
      const uid = expense.member?.uid || expense.user;
      sums.set(uid, addDecimals(sums.get(uid) ?? '0', expense.amount ?? '0', 2));
    }
    if (sums.size === 0) return;
    const lohnart = surchargeLohnart(surchargeId, label);
    if (!lohnart) return;
    for (const [uid, amount] of sums) {
      const number = employeeNumber(uid);
      if (!number) continue;
      push({ employee: number, lohnart, from: period.from, to: period.to, hours: '', days: '', amount, text: label });
    }
  };
  allowance(cfg.taggeldKeyword, 'taggeld', 'Taggeld');
  allowance(cfg.naechtigungsgeldKeyword, 'naechtigungsgeld', 'Nächtigungsgeld');

  lines.sort((a, b) => a.employee.localeCompare(b.employee) || a.lohnart.localeCompare(b.lohnart) || a.from.localeCompare(b.from));

  const writer = new RecordWriter(profileFromConfig(cfg));
  const rows: string[][] = [];
  if (cfg.headerRow) {
    rows.push([...LOHN_COLUMNS]);
  }
  for (const line of lines) {
    rows.push([
      writer.text(cfg.firmennummer, 20),
      writer.text(line.employee, 20),
      writer.text(line.lohnart, 20),
      writer.date(line.from),
      writer.date(line.to),
      line.hours ? writer.number(line.hours, 2) : writer.raw(''),
      line.days ? writer.number(line.days, 2) : writer.raw(''),
      line.amount ? writer.number(line.amount, 2) : writer.raw(''),
      writer.text(line.text, 60)
    ]);
  }

  return {
    text: rows.length > 0 ? writer.build(rows) : '',
    count: lines.length,
    employees: employeesSeen.size,
    warnings: warnings.list()
  };
}
