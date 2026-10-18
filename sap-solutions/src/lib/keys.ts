import type { Member, TaskDto } from '@timesheet/integration-sdk';
import { memberName } from './common';
import type { WarningCollector } from './writer';

/** The member a task belongs to: the API sets `member` on org lists, `user` always. */
export function taskUid(task: TaskDto): string {
  return task.member?.uid || task.user;
}

/**
 * Resolves the SAP key of an employee (personnel number for CATS, user ID for
 * SuccessFactors): the mapping first, then the employee number from the member
 * profile. Missing keys are reported once per employee.
 */
export function employeeKeys(
  mapped: Map<string, string>,
  colleagues: Member[],
  warnings: WarningCollector,
  keyLabel: string
): (uid: string, member?: Member) => string | null {
  const members = new Map<string, Member>();
  for (const member of colleagues) members.set(member.uid, member);
  const reported = new Set<string>();
  return (uid, member) => {
    const fromMapping = mapped.get(uid);
    if (fromMapping) return fromMapping;
    // The colleague list carries the full profile; the member nested in a task or
    // absence may be a stub without the employee number.
    const colleague = members.get(uid);
    const known = colleague ?? member;
    const fromProfile = (colleague?.employeeId || member?.employeeId || '').trim();
    if (fromProfile) return fromProfile;
    if (!reported.has(uid)) {
      reported.add(uid);
      warnings.add('employee-unmapped', `"${memberName(known, uid)}" has no ${keyLabel}. Their rows were skipped.`, { userId: uid });
    }
    return null;
  };
}

/**
 * Picks the SAP type (CATS activity type, SuccessFactors time type) from the task's
 * tags. The first mapped tag wins; tasks with several different mapped values are
 * collected and reported once by `report()`.
 */
export function tagTypes(mapped: Map<string, string>, fallback: string) {
  const conflicts: string[] = [];
  return {
    resolve(task: TaskDto): string {
      const values: string[] = [];
      for (const tag of task.tags ?? []) {
        const value = mapped.get(tag.id);
        if (value && !values.includes(value)) values.push(value);
      }
      if (values.length > 1) conflicts.push(task.id);
      return values[0] ?? fallback;
    },
    report(warnings: WarningCollector, typeLabel: string): void {
      if (conflicts.length === 0) return;
      warnings.add(
        'tag-conflict',
        `${conflicts.length} task(s) carry tags mapped to different ${typeLabel}s. The first mapped tag was used.`,
        { taskIds: conflicts.slice(0, 20) }
      );
    }
  };
}
