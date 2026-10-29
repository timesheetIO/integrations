import { defineHandler } from '@timesheet/integration-sdk';
import { OutlookCalendarConfig, OutlookCalendarSyncInput } from '../lib/types';
import { OutlookCalendarSyncResult, syncTaskToOutlook } from '../lib/taskSync';

export const syncTaskToExternal = defineHandler<OutlookCalendarSyncInput, OutlookCalendarSyncResult, OutlookCalendarConfig>(
  async (input, context) => {
    context.logger.info('Syncing task to Outlook Calendar', {
      installationId: context.installationId,
      taskId: input?.taskId ?? input?.item?.id,
      event: input?.event
    });

    return await syncTaskToOutlook(input, context);
  }
);
