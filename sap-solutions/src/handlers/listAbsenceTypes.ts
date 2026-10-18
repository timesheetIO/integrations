import { defineHandler } from '@timesheet/integration-sdk';
import type { EntityListResult, SapConfig } from '../lib/types';

/** Left side of the absence mapping. Absence types exist on organizations only. */
export const listAbsenceTypes = defineHandler<void, EntityListResult, SapConfig>(async (_input, context) => {
  if (!context.organizationId) return { items: [] };
  const list = await context.data.listAbsenceTypes({ limit: -1 });
  const items = (list?.items ?? [])
    .filter(type => type.active !== false)
    .map(type => ({ id: type.id, name: type.name || type.code || type.id }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { items };
});
