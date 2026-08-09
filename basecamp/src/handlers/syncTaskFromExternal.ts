import { defineHandler } from '@timesheet/integration-sdk';
import { BasecampConfig, SyncInput } from '../lib/types';
import { BasecampSyncResult, handleBasecampWebhook } from '../lib/taskSync';

export const syncTaskFromExternal = defineHandler<SyncInput, BasecampSyncResult, BasecampConfig>(
  async (input, context) => {
    // Basecamp emits no webhook type for timesheet entries, so an inbound
    // invocation can only carry a to-do recording — the same shape the webhook
    // pipeline handles.
    context.logger.info('Syncing from Basecamp payload (legacy entry point)', {
      installationId: context.installationId,
      externalTaskId: input?.externalTaskId
    });

    return await handleBasecampWebhook(input, context);
  }
);
