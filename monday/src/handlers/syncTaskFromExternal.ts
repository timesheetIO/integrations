import { defineHandler } from '@timesheet/integration-sdk';
import { MondayConfig, SyncInput } from '../lib/types';
import { MondaySyncResult, syncTaskFromMonday } from '../lib/taskSync';

export const syncTaskFromExternal = defineHandler<SyncInput, MondaySyncResult, MondayConfig>(
  async (input, context) => {
    context.logger.info('Syncing task from monday.com payload', {
      installationId: context.installationId,
      externalTaskId: input?.externalTaskId
    });

    return await syncTaskFromMonday(input, context);
  }
);
