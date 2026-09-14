import { defineHandler } from '@timesheet/integration-sdk';
import type { BmdConfig, EntityListResult } from '../lib/types';
import { requireOrganization } from '../lib/common';

/** Left side of the Lohnarten mapping: the organization's absence types. */
export const listAbsenceTypes = defineHandler<void, EntityListResult, BmdConfig>(async (_input, context) => {
  requireOrganization(context);
  const list = await context.data.listAbsenceTypes({ limit: -1 });
  const items = (list?.items ?? [])
    .filter(type => type.active !== false)
    .map(type => ({ id: type.id, name: type.name || type.code || type.id }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return { items };
});
