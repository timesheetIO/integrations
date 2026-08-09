import { defineHandler } from '@timesheet/integration-sdk';
import { BasecampConfig, SyncInput } from '../lib/types';
import { BasecampSyncResult, syncTodoFromBasecamp } from '../lib/taskSync';

export const syncTodoFromExternal = defineHandler<SyncInput, BasecampSyncResult, BasecampConfig>(
  async (input, context) => {
    context.logger.info('Syncing Timesheet todo from Basecamp payload', {
      installationId: context.installationId,
      externalTaskId: input?.externalTaskId
    });

    return await syncTodoFromBasecamp(input, context);
  }
);
