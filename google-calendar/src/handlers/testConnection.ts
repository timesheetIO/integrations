import { defineHandler } from '@timesheet/integration-sdk';
import { GoogleCalendarConfig } from '../lib/types';
import { GoogleCalendarClient } from '../lib/googleCalendarClient';

const SYSTEM = 'google-calendar';

function createClient(context: { credentials: { getAccessToken(provider: string): Promise<string>; refreshToken(provider: string): Promise<string>; } }) {
  return new GoogleCalendarClient({
    getAccessToken: () => context.credentials.getAccessToken('google'),
    refreshAccessToken: () => context.credentials.refreshToken('google')
  });
}

export const testConnection = defineHandler<void, { system: string; ok: boolean; installationId: string }, GoogleCalendarConfig>(
  async (_input, context) => {
    const client = createClient(context);
    const ok = await client.testConnection();

    return {
      system: SYSTEM,
      ok,
      installationId: context.installationId
    };
  }
);
