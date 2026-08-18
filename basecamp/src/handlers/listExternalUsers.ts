import { defineHandler, ExternalEntity } from '@timesheet/integration-sdk';
import { BasecampConfig } from '../lib/types';
import { createBasecampClient } from '../lib/taskSync';

const SYSTEM = 'basecamp';
const PROJECT_ENTITY = 'project';

export const listExternalUsers = defineHandler<void, ExternalEntity[], BasecampConfig>(
  async (_input, context) => {
    context.logger.info('Listing Basecamp people', {
      system: SYSTEM,
      installationId: context.installationId
    });

    // Basecamp has no account-wide "people who may own timesheet entries" list:
    // an entry's person must be a non-client member of that project, so the
    // candidates are the people on the mapped projects.
    const projectMappings = await context.mappings.list({ system: SYSTEM, entity: PROJECT_ENTITY });
    const bucketIds = Array.from(
      new Set(projectMappings.map((mapping) => mapping.externalId).filter((id): id is string => !!id))
    );
    if (bucketIds.length === 0) {
      return [];
    }

    const client = createBasecampClient(context);
    const byId = new Map<string, ExternalEntity>();

    for (const bucketId of bucketIds) {
      try {
        for (const person of await client.listProjectPeople(bucketId)) {
          if (person.client) continue;
          const id = String(person.id);
          if (byId.has(id)) continue;
          byId.set(id, {
            id,
            name: person.name ?? person.email_address ?? id,
            email: person.email_address ?? ''
          });
        }
      } catch (err) {
        context.logger.warn('Failed to list people for Basecamp project', {
          bucketId,
          error: String(err)
        });
      }
    }

    return Array.from(byId.values());
  }
);
