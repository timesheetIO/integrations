import { defineHandler } from '@timesheet/integration-sdk';
import { ClickUpConfig, SyncInput } from '../lib/types';
import { ClickUpSyncResult, syncTodoToClickUp } from '../lib/taskSync';

export const syncTodoToExternal = defineHandler<SyncInput, ClickUpSyncResult, ClickUpConfig>(
  async (input, context) => {
    context.logger.info('Syncing todo to ClickUp', {
      installationId: context.installationId,
      event: input?.event,
      todoId: input?.todoId ?? input?.item?.id
    });

    return await syncTodoToClickUp(input, context);
  }
);
