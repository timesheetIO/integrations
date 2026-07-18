import { defineHandler } from '@timesheet/integration-sdk';
import { NotionConfig, SyncInput } from '../lib/types';
import { NotionSyncResult, syncTaskToNotion } from '../lib/taskSync';

export const syncTaskToExternal = defineHandler<SyncInput, NotionSyncResult, NotionConfig>(
  async (input, context) => {
    context.logger.info('Syncing Timesheet task → Notion time-log page', {
      installationId: context.installationId,
      taskId: input?.taskId ?? input?.item?.id,
      event: input?.event
    });

    return await syncTaskToNotion(input, context);
  }
);
