import { defineHandler } from '@timesheet/integration-sdk';
import { OutlookCalendarConfig } from '../lib/types';
import { createClient } from '../lib/taskSync';

const SYSTEM = 'outlook-calendar';

export const testConnection = defineHandler<void, { system: string; ok: boolean; installationId: string }, OutlookCalendarConfig>(
  async (_input, context) => {
    const ok = await createClient(context).testConnection();

    return {
      system: SYSTEM,
      ok,
      installationId: context.installationId
    };
  }
);
