import { defineHandler } from '@timesheet/integration-sdk';
import { NotionConfig } from '../lib/types';
import { NotionSyncResult, createTimeLogDatabase as createTimeLogDatabaseInNotion } from '../lib/taskSync';

export const createTimeLogDatabase = defineHandler<void, NotionSyncResult, NotionConfig>(
  async (_input, context) => {
    context.logger.info('Creating the Notion time-log database', {
      installationId: context.installationId
    });

    return await createTimeLogDatabaseInNotion(context);
  }
);
