import { defineHandler, ScheduleInput } from '@timesheet/integration-sdk';
import { GoogleHealthConfig, SyncResult } from '../lib/types';
import { syncExercises } from '../lib/exerciseSync';

export const handleScheduledSync = defineHandler<ScheduleInput, SyncResult, GoogleHealthConfig>(
  async (input, context) => {
    context.logger.info('Running Google Health scheduled sync', {
      installationId: context.installationId,
      scheduledTime: input?.scheduledTime,
      lastRunTime: input?.lastRunTime
    });
    return await syncExercises(context);
  }
);
