import { defineHandler } from '@timesheet/integration-sdk';
import { GoogleHealthConfig, SyncResult } from '../lib/types';
import { syncExercises } from '../lib/exerciseSync';

export const runFullSync = defineHandler<void, SyncResult, GoogleHealthConfig>(
  async (_input, context) => {
    context.logger.info('Running Google Health manual sync', {
      installationId: context.installationId
    });
    return await syncExercises(context);
  }
);
