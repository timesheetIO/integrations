import { defineHandler } from '@timesheet/integration-sdk';
import { OutlookCalendarConfig, OutlookCalendarSyncInput } from '../lib/types';
import { OutlookCalendarSyncResult, handleOutlookNotifications } from '../lib/taskSync';

export const syncTaskFromExternal = defineHandler<OutlookCalendarSyncInput, OutlookCalendarSyncResult, OutlookCalendarConfig>(
  async (input, context) => {
    context.logger.info('Syncing tasks from an Outlook Calendar payload', {
      installationId: context.installationId
    });

    return await handleOutlookNotifications(input, context);
  }
);
