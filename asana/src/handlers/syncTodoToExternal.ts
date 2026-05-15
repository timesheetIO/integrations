import { defineHandler } from '@timesheet/integration-sdk';
import { AsanaConfig, SyncInput } from '../lib/types';
import { AsanaSyncResult, syncTodoToAsana } from '../lib/taskSync';

export const syncTodoToExternal = defineHandler<SyncInput, AsanaSyncResult, AsanaConfig>(
  async (input, context) => {
    context.logger.info('Syncing Timesheet todo → Asana task', {
      installationId: context.installationId,
      todoId: input?.entityId ?? input?.item?.id,
      event: input?.event
    });

    return await syncTodoToAsana(input, context);
  }
);
