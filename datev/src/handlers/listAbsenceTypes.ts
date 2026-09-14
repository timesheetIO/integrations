import { defineHandler, ExternalEntity } from '@timesheet/integration-sdk';
import { pageAll, requireOrganization } from '../lib/common';
import { DatevConfig } from '../lib/types';

/** Left side of the wage type mapping. */
export const listAbsenceTypes = defineHandler<unknown, ExternalEntity[], DatevConfig>(async (_input, context) => {
  requireOrganization(context);
  const types = await pageAll((page, limit, count) => context.data.listAbsenceTypes({ page, limit, count }));
  return types
    .filter(type => type.active !== false)
    .map(type => ({ id: type.id, name: type.name ?? type.code ?? type.id }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
});
