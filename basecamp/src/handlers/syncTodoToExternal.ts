import { defineHandler } from '@timesheet/integration-sdk';
import { BasecampConfig, SyncInput } from '../lib/types';
import { BasecampSyncResult, syncTodoToBasecamp } from '../lib/taskSync';

export const syncTodoToExternal = defineHandler<SyncInput, BasecampSyncResult, BasecampConfig>(
  async (input, context) => {
    context.logger.info('Syncing Timesheet todo → Basecamp to-do', {
      installationId: context.installationId,
      todoId: input?.entityId ?? input?.item?.id,
      event: input?.event
    });

    return await syncTodoToBasecamp(input, context);
  }
);
