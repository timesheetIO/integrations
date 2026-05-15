import { defineHandler } from '@timesheet/integration-sdk';
import { AsanaConfig, SyncInput } from '../lib/types';
import { AsanaSyncResult, handleAsanaWebhook } from '../lib/taskSync';

export const syncTaskFromExternal = defineHandler<SyncInput, AsanaSyncResult, AsanaConfig>(
  async (input, context) => {
    // For Asana, inbound task/time-entry events flow through the same webhook
    // pipeline — there's no first-class "fetch one entry" entry-point that's
    // different from a generic webhook invocation.
    context.logger.info('Syncing from Asana payload (legacy entry point)', {
      installationId: context.installationId,
      externalTaskId: input?.externalTaskId
    });

    return await handleAsanaWebhook(input, context);
  }
);
