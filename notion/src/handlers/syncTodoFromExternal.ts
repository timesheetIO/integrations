import { defineHandler } from '@timesheet/integration-sdk';
import { NotionConfig, SyncInput } from '../lib/types';
import { NotionSyncResult, syncTodoFromNotion } from '../lib/taskSync';

export const syncTodoFromExternal = defineHandler<SyncInput, NotionSyncResult, NotionConfig>(
  async (input, context) => {
    context.logger.info('Syncing todo from Notion payload', {
      installationId: context.installationId,
      externalTaskId: input?.externalTaskId
    });

    return await syncTodoFromNotion(input, context);
  }
);
