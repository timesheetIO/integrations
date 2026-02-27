import { defineHandler, TaskCreatedInput } from '@timesheet/integration-sdk';

const SYSTEM = 'clickup';

export const syncTaskToExternal = defineHandler<TaskCreatedInput, { system: string; taskId: string; direction: string }>(
  async (input, context) => {
    context.logger.info('Syncing task to external system', {
      system: SYSTEM,
      taskId: input.taskId,
      installationId: context.installationId
    });

    return {
      system: SYSTEM,
      taskId: input.taskId,
      direction: 'timesheet-to-external'
    };
  }
);
