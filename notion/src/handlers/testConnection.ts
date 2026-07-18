import { defineHandler } from '@timesheet/integration-sdk';
import { NotionConfig } from '../lib/types';
import { createNotionClient } from '../lib/taskSync';

const SYSTEM = 'notion';

export const testConnection = defineHandler<
  void,
  { system: string; ok: boolean; installationId: string; botId: string },
  NotionConfig
>(async (_input, context) => {
  const client = createNotionClient(context);

  try {
    const bot = await client.getBotUser();
    return {
      system: SYSTEM,
      ok: !!bot?.id,
      installationId: context.installationId,
      botId: bot?.id ?? ''
    };
  } catch (err) {
    context.logger.warn('Notion test connection failed', { error: String(err) });
    return {
      system: SYSTEM,
      ok: false,
      installationId: context.installationId,
      botId: ''
    };
  }
});
