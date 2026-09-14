import { defineHandler } from '@timesheet/integration-sdk';
import type { BmdConfig, EntityListResult } from '../lib/types';
import { customerKey, pageAll, requireOrganization } from '../lib/common';

const PAGE = 100;
const MAX_PAGES = 50;

/**
 * Distinct customers seen on invoices, newest first. Invoices are the only place customer
 * identity exists, so this list is the left side of the Debitorenkonten mapping.
 */
export const listCustomers = defineHandler<void, EntityListResult, BmdConfig>(async (_input, context) => {
  const organizationId = requireOrganization(context);
  const documents = await pageAll(
    page => context.data.listDocuments({ organizationId, category: 0, template: false, sort: 'date', order: 'DESC', page, limit: PAGE }),
    { firstPage: 1, limit: PAGE, maxPages: MAX_PAGES }
  );
  const seen = new Map<string, string>();
  for (const doc of documents) {
    const key = customerKey(doc);
    if (!key || seen.has(key)) continue;
    const name = (doc.customer ?? '').trim();
    const id = (doc.customerId ?? '').trim();
    seen.set(key, name && id && name !== id ? `${name} (${id})` : name || id);
  }
  const items = [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return { items };
});
