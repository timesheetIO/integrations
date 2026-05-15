import { defineHandler } from '@timesheet/integration-sdk';
import { AsanaConfig, SyncInput } from '../lib/types';
import { AsanaSyncResult, syncTimesheetTaskToAsana } from '../lib/taskSync';

export const syncTaskToExternal = defineHandler<SyncInput, AsanaSyncResult, AsanaConfig>(
  async (input, context) => {
    context.logger.info('Syncing Timesheet task → Asana time entry', {
      installationId: context.installationId,
      taskId: input?.taskId ?? input?.item?.id,
      event: input?.event
    });

    return await syncTimesheetTaskToAsana(input, context);
  }
);
