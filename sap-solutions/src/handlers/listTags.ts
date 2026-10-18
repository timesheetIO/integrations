import { defineHandler } from '@timesheet/integration-sdk';
import type { EntityListResult, SapConfig } from '../lib/types';

/** Left side of the activity type / time type mapping: the tags visible to the installer. */
export const listTags = defineHandler<void, EntityListResult, SapConfig>(async (_input, context) => {
  const list = await context.data.listTags({ limit: -1 });
  const items = (list?.items ?? [])
    .filter(tag => !tag.deleted && !tag.archived)
    .map(tag => ({ id: tag.id, name: tag.name || tag.id }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { items };
});
