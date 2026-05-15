import { defineHandler } from '@timesheet/integration-sdk';
import { AsanaConfig, SyncInput } from '../lib/types';
import { AsanaSyncResult, syncTodoFromAsana } from '../lib/taskSync';

export const syncTodoFromExternal = defineHandler<SyncInput, AsanaSyncResult, AsanaConfig>(
  async (input, context) => {
    context.logger.info('Syncing Timesheet todo from Asana payload', {
      installationId: context.installationId,
      externalTaskId: input?.externalTaskId
    });

    return await syncTodoFromAsana(input, context);
  }
);
