import { defineHandler } from '@timesheet/integration-sdk';
import { ClickUpConfig, SyncInput } from '../lib/types';
import { ClickUpSyncResult, syncTaskFromClickUp } from '../lib/taskSync';

export const syncTaskFromExternal = defineHandler<SyncInput, ClickUpSyncResult, ClickUpConfig>(
  async (input, context) => {
    context.logger.info('Syncing task from ClickUp payload', {
      installationId: context.installationId,
      externalTaskId: input?.externalTaskId
    });

    return await syncTaskFromClickUp(input, context);
  }
);
