import { defineHandler, DocumentDto, ExternalEntity } from '@timesheet/integration-sdk';
import { pageAll, requireOrganization, resolveConfig } from '../lib/common';
import { DatevConfig } from '../lib/types';
import { customerKey } from './buildBuchungsstapel';

/**
 * Left side of the debtor mapping. Invoices are the only place a customer exists, so
 * the list is the distinct customers of the invoices in the configured window.
 */
export const listCustomers = defineHandler<unknown, ExternalEntity[], DatevConfig>(async (_input, context) => {
  const organizationId = requireOrganization(context);
  const config = resolveConfig(context.config);
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - config.customerWindowMonths, 1));
  const documents = await pageAll<DocumentDto>((page, limit, count) =>
    context.data.listDocuments({
      organizationId,
      category: 0,
      template: false,
      startDate: start.toISOString().slice(0, 10),
      endDate: now.toISOString().slice(0, 10),
      page,
      limit,
      count
    })
  );
  const customers = new Map<string, string>();
  for (const doc of documents) {
    const key = customerKey(doc);
    if (!key) continue;
    const name = (doc.customer ?? '').trim() || key;
    if (!customers.has(key)) customers.set(key, name);
  }
  return [...customers.entries()]
    .map(([id, name]) => ({ id, name: name === id ? name : `${name} (${id})` }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
});
