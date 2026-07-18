import { defineHandler } from '@timesheet/integration-sdk';
import { NotionConfig, SyncInput } from '../lib/types';
import { NotionSyncResult, syncTodoToNotion } from '../lib/taskSync';

export const syncTodoToExternal = defineHandler<SyncInput, NotionSyncResult, NotionConfig>(
  async (input, context) => {
    context.logger.info('Syncing todo to Notion page', {
      installationId: context.installationId,
      todoId: input?.entityId ?? input?.item?.id,
      event: input?.event
    });

    return await syncTodoToNotion(input, context);
  }
);
