import type { AbsenceDto, ExpenseDto, IntegrationContext, Member, OvertimeBalanceDto, TaskDto } from '@timesheet/integration-sdk';
import { chunk, loadMappingIndex, pageAll } from './common';
import type { Period, ResolvedConfig } from './types';
import { PeriodGuard, WarningCollector, addDecimals, isoDate, toScaled } from './writer';

/** One payroll movement: a wage type with a value for one employee in the period. */
export interface WageLine {
  lohnart: string;
  /** hours, days or an amount as a decimal string with 2 places */
  value: string;
  kind: 'hours' | 'days' | 'amount';
  label: string;
}

export interface EmployeeFacts {
  uid: string;
  displayName: string;
  firstname: string;
  lastname: string;
  personalnummer: string;
  workedMinutes: number;
  overtimeMinutes: number;
  undertimeMinutes: number;
  absences: Array<{ absenceTypeId: string; absenceTypeName: string; days: string; hours: string; fullDay: boolean }>;
  /** Travel allowances summed from expenses whose description matches a configured keyword. */
  allowances: Array<{ key: AllowanceKey; amount: string; label: string }>;
  lines: WageLine[];
}

export type AllowanceKey = 'taggeld' | 'naechtigungsgeld';

export const ALLOWANCE_LABELS: Record<AllowanceKey, string> = { taggeld: 'Taggeld', naechtigungsgeld: 'Nächtigungsgeld' };

export interface PayrollFacts {
  employees: EmployeeFacts[];
  /** Employees with activity but no Personalnummer; reported, not exported. */
  skipped: Array<{ uid: string; displayName: string }>;
}

function splitName(member: Member): { firstname: string; lastname: string } {
  const firstname = (member.firstname ?? '').trim();
  const lastname = (member.lastname ?? '').trim();
  if (firstname || lastname) return { firstname, lastname };
  const display = (member.displayName ?? '').trim();
  const idx = display.lastIndexOf(' ');
  if (idx < 0) return { firstname: '', lastname: display };
  return { firstname: display.slice(0, idx), lastname: display.slice(idx + 1) };
}

function taskMinutes(task: TaskDto): number {
  if (task.running) return 0;
  const seconds = typeof task.duration === 'number' && task.duration > 0 ? task.duration : null;
  if (seconds !== null) return Math.round(seconds / 60);
  if (task.startDateTime && task.endDateTime) {
    const ms = Date.parse(task.endDateTime) - Date.parse(task.startDateTime);
    const breakSeconds = typeof task.durationBreak === 'number' ? task.durationBreak : 0;
    return Math.max(0, Math.round(ms / 60000 - breakSeconds / 60));
  }
  return 0;
}

function calendarDays(from: string, to: string): number {
  const a = Date.parse(`${isoDate(from)}T00:00:00Z`);
  const b = Date.parse(`${isoDate(to)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

/**
 * Days and hours of an absence inside the period. Absences fully inside the period use
 * the backend's totals; absences crossing the period boundary are prorated by calendar
 * days and reported as a warning, because the backend totals cover the whole absence.
 */
export function absenceShare(
  absence: AbsenceDto,
  guard: PeriodGuard,
  warnings: WarningCollector
): { days: string; hours: string } | null {
  const start = isoDate(absence.startDateTime);
  const end = isoDate(absence.endDateTime);
  const overlap = guard.clamp(start, end);
  if (!overlap) return null;
  const totalDays = toScaled(absence.totalDays ?? '0', 2);
  const totalHours = toScaled(absence.totalHours ?? '0', 2);
  if (overlap.start === start && overlap.end === end) {
    return { days: totalDays, hours: totalHours };
  }
  const span = calendarDays(start, end);
  const inside = calendarDays(overlap.start, overlap.end);
  const ratio = inside / span;
  warnings.add('absence_prorated', 'Abwesenheit liegt nur teilweise im Zeitraum, Anteil nach Kalendertagen berechnet', {
    absenceId: absence.id,
    start,
    end,
    daysInPeriod: inside
  });
  return {
    days: toScaled(Number(totalDays) * ratio, 2),
    hours: toScaled(Number(totalHours) * ratio, 2)
  };
}

export function minutesToHours(minutes: number): string {
  return toScaled(minutes / 60, 2);
}

export async function collectPayrollFacts(
  context: IntegrationContext<unknown>,
  config: ResolvedConfig,
  period: Period,
  warnings: WarningCollector
): Promise<PayrollFacts> {
  const guard = new PeriodGuard(period.from, period.to);

  const colleagues = await pageAll<Member>((page, limit, count) =>
    context.data.getColleagues({ page, limit, count, withoutMe: false, deleted: false })
  );
  const members = new Map<string, Member>();
  for (const member of colleagues) {
    if (member?.uid) members.set(member.uid, member);
  }

  const [employeeMap, wageTypeMap] = await Promise.all([
    loadMappingIndex(context, 'user'),
    loadMappingIndex(context, 'absence_type')
  ]);

  const absenceTypes = await pageAll((page, limit, count) => context.data.listAbsenceTypes({ page, limit, count }));
  const typeNames = new Map<string, string>();
  for (const type of absenceTypes) {
    typeNames.set(type.id, type.name ?? type.code ?? type.id);
  }

  const worked = new Map<string, number>();
  for (const uids of chunk([...members.keys()], 50)) {
    const tasks = await pageAll<TaskDto>((page, limit, count) =>
      context.data.listTasks({
        startDate: period.from,
        endDate: period.to,
        userIds: uids,
        page,
        limit,
        count,
        populatePauses: false,
        populateExpenses: false,
        populateNotes: false,
        populateTags: false
      })
    );
    for (const task of tasks) {
      if (!task.user || task.deleted) continue;
      if (task.startDateTime && !guard.contains(task.startDateTime)) continue;
      worked.set(task.user, (worked.get(task.user) ?? 0) + taskMinutes(task));
    }
  }

  const absences = await pageAll<AbsenceDto>((page, limit, count) =>
    context.data.listAbsences({ startDate: period.from, endDate: period.to, statuses: ['approved'], page, limit, count })
  );
  const absencesByUser = new Map<string, EmployeeFacts['absences']>();
  const unmappedTypes = new Set<string>();
  for (const absence of absences) {
    const uid = absence.member?.uid;
    if (!uid) continue;
    if ((absence.status ?? 'APPROVED').toUpperCase() !== 'APPROVED') continue;
    const share = absenceShare(absence, guard, warnings);
    if (!share) continue;
    const typeId = absence.absenceTypeId ?? absence.absenceType?.id ?? '';
    const typeName = absence.absenceType?.name ?? typeNames.get(typeId) ?? typeId;
    const list = absencesByUser.get(uid) ?? [];
    list.push({ absenceTypeId: typeId, absenceTypeName: typeName, days: share.days, hours: share.hours, fullDay: absence.fullDay !== false });
    absencesByUser.set(uid, list);
    if (!wageTypeMap.has(typeId)) unmappedTypes.add(typeId);
  }
  for (const typeId of unmappedTypes) {
    warnings.add('absence_type_unmapped', 'Abwesenheitsart ohne Lohnart, Abwesenheiten dieser Art wurden ausgelassen', {
      absenceTypeId: typeId,
      absenceTypeName: typeNames.get(typeId) ?? typeId
    });
  }

  const balances = await pageAll<OvertimeBalanceDto>((page, limit, count) =>
    context.data.listOvertimeBalances({ startDate: period.from, endDate: period.to, page, limit, count })
  );
  const overtime = new Map<string, { over: number; under: number }>();
  for (const balance of balances) {
    const uid = balance.member?.uid;
    if (!uid) continue;
    if (balance.periodStart && !guard.contains(balance.periodStart)) continue;
    const entry = overtime.get(uid) ?? { over: 0, under: 0 };
    entry.over += balance.overtimeMinutes ?? 0;
    entry.under += balance.undertimeMinutes ?? 0;
    overtime.set(uid, entry);
  }

  // Travel allowances from expenses: keyword match on the description, summed per employee.
  const allowancesByUser = new Map<string, EmployeeFacts['allowances']>();
  const allKeywords: Array<{ key: AllowanceKey; keyword: string; lohnart: string }> = [
    { key: 'taggeld', keyword: config.taggeldKeyword, lohnart: config.lohnartTaggeld },
    { key: 'naechtigungsgeld', keyword: config.naechtigungsgeldKeyword, lohnart: config.lohnartNaechtigungsgeld }
  ];
  const keywords = allKeywords.filter(k => k.keyword.trim() !== '');
  if (keywords.length > 0) {
    const expenses = await pageAll<ExpenseDto>((page, limit, count) =>
      context.data.listExpenses({ startDate: period.from, endDate: period.to, page, limit, count })
    );
    for (const { key, keyword, lohnart } of keywords) {
      const needle = keyword.trim().toLowerCase();
      const sums = new Map<string, string>();
      for (const expense of expenses) {
        if (expense.deleted) continue;
        if (expense.dateTime && !guard.contains(expense.dateTime)) continue;
        if (!(expense.description ?? '').toLowerCase().includes(needle)) continue;
        const uid = expense.member?.uid || expense.user;
        if (!uid) continue;
        sums.set(uid, addDecimals(sums.get(uid) ?? '0', expense.amount ?? '0', 2));
      }
      if (sums.size === 0) continue;
      if (!lohnart) {
        warnings.add('expense_lohnart_missing', 'Keine Lohnart fuer diese Reisekosten konfiguriert, Betraege wurden nicht uebergeben', {
          keyword,
          label: ALLOWANCE_LABELS[key]
        });
        continue;
      }
      for (const [uid, amount] of sums) {
        const list = allowancesByUser.get(uid) ?? [];
        list.push({ key, amount, label: ALLOWANCE_LABELS[key] });
        allowancesByUser.set(uid, list);
      }
    }
  }

  if (!config.lohnartArbeitsstunden && worked.size > 0) {
    warnings.add('wage_type_hours_missing', 'Keine Lohnart fuer Arbeitsstunden konfiguriert, Arbeitsstunden wurden nicht uebergeben');
  }

  const activeUids = new Set<string>([...worked.keys(), ...absencesByUser.keys(), ...overtime.keys(), ...allowancesByUser.keys()]);
  const employees: EmployeeFacts[] = [];
  const skipped: PayrollFacts['skipped'] = [];

  for (const uid of [...activeUids].sort()) {
    const member = members.get(uid);
    const displayName = member?.displayName ?? uid;
    const personalnummer = (employeeMap.get(uid) ?? member?.employeeId ?? '').trim();
    if (!personalnummer) {
      skipped.push({ uid, displayName });
      warnings.add('employee_without_personalnummer', 'Mitarbeiter ohne Personalnummer, nicht exportiert', { uid, displayName });
      continue;
    }
    const names = member ? splitName(member) : { firstname: '', lastname: displayName };
    const facts: EmployeeFacts = {
      uid,
      displayName,
      firstname: names.firstname,
      lastname: names.lastname,
      personalnummer,
      workedMinutes: worked.get(uid) ?? 0,
      overtimeMinutes: overtime.get(uid)?.over ?? 0,
      undertimeMinutes: overtime.get(uid)?.under ?? 0,
      absences: absencesByUser.get(uid) ?? [],
      allowances: allowancesByUser.get(uid) ?? [],
      lines: []
    };
    facts.lines = buildWageLines(facts, config, wageTypeMap);
    employees.push(facts);
  }

  return { employees, skipped };
}

export function buildWageLines(facts: EmployeeFacts, config: ResolvedConfig, wageTypeMap: Map<string, string>): WageLine[] {
  const lines: WageLine[] = [];
  if (config.lohnartArbeitsstunden && facts.workedMinutes > 0) {
    lines.push({ lohnart: config.lohnartArbeitsstunden, value: minutesToHours(facts.workedMinutes), kind: 'hours', label: 'Arbeitsstunden' });
  }
  if (config.lohnartUeberstunden && facts.overtimeMinutes > 0) {
    lines.push({ lohnart: config.lohnartUeberstunden, value: minutesToHours(facts.overtimeMinutes), kind: 'hours', label: 'Ueberstunden' });
  }
  if (config.lohnartMinderstunden && facts.undertimeMinutes > 0) {
    lines.push({ lohnart: config.lohnartMinderstunden, value: minutesToHours(facts.undertimeMinutes), kind: 'hours', label: 'Minderstunden' });
  }
  // Absences of the same type are summed into one line per wage type.
  const byType = new Map<string, { lohnart: string; days: string; hours: string; fullDay: boolean; label: string }>();
  for (const absence of facts.absences) {
    const lohnart = wageTypeMap.get(absence.absenceTypeId);
    if (!lohnart) continue;
    const entry = byType.get(absence.absenceTypeId) ?? { lohnart, days: '0.00', hours: '0.00', fullDay: absence.fullDay, label: absence.absenceTypeName };
    entry.days = addDecimals(entry.days, absence.days, 2);
    entry.hours = addDecimals(entry.hours, absence.hours, 2);
    entry.fullDay = entry.fullDay && absence.fullDay;
    byType.set(absence.absenceTypeId, entry);
  }
  for (const entry of byType.values()) {
    const useDays = entry.fullDay && entry.days !== '0.00';
    lines.push({
      lohnart: entry.lohnart,
      value: useDays ? entry.days : entry.hours,
      kind: useDays ? 'days' : 'hours',
      label: entry.label
    });
  }
  const allowanceLohnart: Record<AllowanceKey, string> = { taggeld: config.lohnartTaggeld, naechtigungsgeld: config.lohnartNaechtigungsgeld };
  for (const allowance of facts.allowances) {
    const lohnart = allowanceLohnart[allowance.key];
    if (!lohnart || allowance.amount === '0.00') continue;
    lines.push({ lohnart, value: allowance.amount, kind: 'amount', label: allowance.label });
  }
  return lines;
}
