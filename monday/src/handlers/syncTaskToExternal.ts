import { defineHandler } from '@timesheet/integration-sdk';
import { MondayConfig, SyncInput } from '../lib/types';
import { MondaySyncResult, syncTaskToMonday } from '../lib/taskSync';

export const syncTaskToExternal = defineHandler<SyncInput, MondaySyncResult, MondayConfig>(
  async (input, context) => {
    context.logger.info('Syncing task to monday.com', {
      installationId: context.installationId,
      event: input?.event,
      taskId: input?.taskId ?? input?.item?.id
    });

    return await syncTaskToMonday(input, context);
  }
);
