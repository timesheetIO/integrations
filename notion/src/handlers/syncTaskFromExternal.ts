import { defineHandler } from '@timesheet/integration-sdk';
import { NotionConfig, SyncInput } from '../lib/types';
import { NotionSyncResult, syncTodoFromNotion } from '../lib/taskSync';

// Inbound single-page sync routes by the page's parent database, so time-log
// rows and todo pages share the same entry point.
export const syncTaskFromExternal = defineHandler<SyncInput, NotionSyncResult, NotionConfig>(
  async (input, context) => {
    context.logger.info('Syncing task from Notion payload', {
      installationId: context.installationId,
      externalTaskId: input?.externalTaskId
    });

    return await syncTodoFromNotion(input, context);
  }
);
