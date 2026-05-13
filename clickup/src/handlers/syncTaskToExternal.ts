import { defineHandler } from '@timesheet/integration-sdk';
import { ClickUpConfig, SyncInput } from '../lib/types';
import { ClickUpSyncResult, syncTaskToClickUp } from '../lib/taskSync';

export const syncTaskToExternal = defineHandler<SyncInput, ClickUpSyncResult, ClickUpConfig>(
  async (input, context) => {
    context.logger.info('Syncing task to ClickUp', {
      installationId: context.installationId,
      event: input?.event,
      taskId: input?.taskId ?? input?.item?.id
    });

    return await syncTaskToClickUp(input, context);
  }
);
