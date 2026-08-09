import { defineHandler } from '@timesheet/integration-sdk';
import { BasecampConfig, SyncInput } from '../lib/types';
import { BasecampSyncResult, syncTimesheetTaskToBasecamp } from '../lib/taskSync';

export const syncTaskToExternal = defineHandler<SyncInput, BasecampSyncResult, BasecampConfig>(
  async (input, context) => {
    context.logger.info('Syncing Timesheet task → Basecamp timesheet entry', {
      installationId: context.installationId,
      taskId: input?.taskId ?? input?.item?.id,
      event: input?.event
    });

    return await syncTimesheetTaskToBasecamp(input, context);
  }
);
