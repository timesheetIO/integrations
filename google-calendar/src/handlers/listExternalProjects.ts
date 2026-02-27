import { defineHandler, ExternalEntity } from '@timesheet/integration-sdk';
import { GoogleCalendarConfig } from '../lib/types';
import { GoogleCalendarClient } from '../lib/googleCalendarClient';

const SYSTEM = 'google-calendar';

function createClient(context: { credentials: { getAccessToken(provider: string): Promise<string>; refreshToken(provider: string): Promise<string>; } }) {
  return new GoogleCalendarClient({
    getAccessToken: () => context.credentials.getAccessToken('google'),
    refreshAccessToken: () => context.credentials.refreshToken('google')
  });
}

export const listExternalProjects = defineHandler<void, ExternalEntity[], GoogleCalendarConfig>(async (_input, context) => {
  context.logger.info('Listing Google Calendar calendars', {
    system: SYSTEM,
    installationId: context.installationId
  });

  const client = createClient(context);
  return await client.listCalendars();
});
