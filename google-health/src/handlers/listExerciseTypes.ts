import { defineHandler, ExternalEntity } from '@timesheet/integration-sdk';
import { GoogleHealthConfig } from '../lib/types';
import { CURATED_EXERCISE_TYPES } from '../lib/exerciseTypes';
import { PLUGIN_SYSTEM } from '../lib/exerciseSync';

export const listExerciseTypes = defineHandler<void, ExternalEntity[], GoogleHealthConfig>(
  async (_input, context) => {
    context.logger.info('Listing Google Health exercise types', {
      system: PLUGIN_SYSTEM,
      installationId: context.installationId,
      count: CURATED_EXERCISE_TYPES.length
    });
    return CURATED_EXERCISE_TYPES;
  }
);
