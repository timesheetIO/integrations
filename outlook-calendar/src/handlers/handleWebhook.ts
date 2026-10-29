import { defineHandler } from '@timesheet/integration-sdk';
import { OutlookCalendarConfig, OutlookCalendarSyncInput } from '../lib/types';
import { OutlookCalendarSyncResult, handleOutlookNotifications } from '../lib/taskSync';

export const handleWebhook = defineHandler<OutlookCalendarSyncInput, OutlookCalendarSyncResult, OutlookCalendarConfig>(
  async (input, context) => {
    context.logger.info('Handling Outlook Calendar notifications', {
      installationId: context.installationId
    });

    return await handleOutlookNotifications(input, context);
  }
);
