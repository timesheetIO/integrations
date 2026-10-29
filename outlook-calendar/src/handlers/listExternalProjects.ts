import { defineHandler, ExternalEntity } from '@timesheet/integration-sdk';
import { OutlookCalendarConfig } from '../lib/types';
import { createClient } from '../lib/taskSync';

export const listExternalProjects = defineHandler<void, ExternalEntity[], OutlookCalendarConfig>(async (_input, context) => {
  context.logger.info('Listing Outlook calendars', {
    installationId: context.installationId
  });

  return await createClient(context).listCalendars();
});
