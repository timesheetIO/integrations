import { IntegrationContext, MappingRecord } from '@timesheet/integration-sdk';
import { GoogleHealthClient } from './googleHealthClient';
import { labelForExerciseType } from './exerciseTypes';
import { GoogleHealthConfig, GoogleHealthExercise, SyncResult } from './types';

export const PLUGIN_SYSTEM = 'google-health';
export const EXERCISE_TYPE_ENTITY = 'exercise_type';
export const WORKOUT_ENTITY = 'workout';

const LOOKBACK_DAYS_DEFAULT = 7;
const LOOKBACK_DAYS_MIN = 1;
const LOOKBACK_DAYS_MAX = 90;
const STATE_LAST_SYNC = 'lastSyncTime';

export function createGoogleHealthClient(context: IntegrationContext<GoogleHealthConfig>): GoogleHealthClient {
  return new GoogleHealthClient({
    getAccessToken: () => context.credentials.getAccessToken('google'),
    refreshAccessToken: () => context.credentials.refreshToken('google')
  });
}

/**
 * Inbound sync: pull new Google Health exercise sessions since the last successful sync
 * (or `lookbackDays` ago on first run) and create a Timesheet task for each on the
 * project mapped to the workout's exercise type (or the configured fallback project).
 *
 * Already-imported workouts are detected via the `workout` mapping table and skipped.
 */
export async function syncExercises(context: IntegrationContext<GoogleHealthConfig>): Promise<SyncResult> {
  const config = context.config ?? {};
  const lookbackDays = clampLookback(config.lookbackDays);
  const fallbackProjectId = config.fallbackProjectId?.trim() || undefined;
  const syncTagId = config.syncTagId?.trim() || undefined;

  const now = new Date();
  const lastSync = (await context.state.get<string>(STATE_LAST_SYNC)) ?? undefined;
  const sinceTime = lastSync ?? new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  const exerciseTypeMappings = await context.mappings.list({
    system: PLUGIN_SYSTEM,
    entity: EXERCISE_TYPE_ENTITY
  });
  const projectByExerciseType = new Map<string, string>();
  for (const mapping of exerciseTypeMappings) {
    // localId = Timesheet project id, externalId = exercise type key (e.g. "RUN").
    projectByExerciseType.set(mapping.externalId, mapping.localId);
  }

  context.logger.info('Starting Google Health exercise sync', {
    installationId: context.installationId,
    sinceTime,
    mappedExerciseTypes: projectByExerciseType.size,
    hasFallbackProject: Boolean(fallbackProjectId)
  });

  const client = createGoogleHealthClient(context);

  let imported = 0;
  let skippedAlreadySynced = 0;
  let skippedNoMapping = 0;
  const errors: Array<{ exerciseId: string; error: string }> = [];

  try {
    for await (const exercise of client.iterateExercises({ startTimeAfter: sinceTime })) {
      try {
        const result = await importExercise(context, exercise, {
          projectByExerciseType,
          fallbackProjectId,
          syncTagId
        });
        switch (result) {
          case 'imported':
            imported += 1;
            break;
          case 'skipped-already-synced':
            skippedAlreadySynced += 1;
            break;
          case 'skipped-no-mapping':
            skippedNoMapping += 1;
            break;
        }
      } catch (err) {
        context.logger.error('Failed to import exercise', {
          exerciseId: exercise.id,
          error: String(err)
        });
        errors.push({ exerciseId: exercise.id, error: String(err) });
      }
    }
  } catch (err) {
    context.logger.error('Google Health sync failed before completion', { error: String(err) });
    return {
      system: PLUGIN_SYSTEM,
      status: 'failed',
      syncedCount: imported,
      details: {
        imported,
        skippedAlreadySynced,
        skippedNoMapping,
        sinceTime,
        errors: [...errors, { exerciseId: '*', error: String(err) }]
      }
    };
  }

  await context.state.set(STATE_LAST_SYNC, now.toISOString());

  return {
    system: PLUGIN_SYSTEM,
    status: errors.length > 0 ? 'partial' : 'completed',
    syncedCount: imported,
    details: {
      imported,
      skippedAlreadySynced,
      skippedNoMapping,
      sinceTime,
      until: now.toISOString(),
      errors: errors.length > 0 ? errors : undefined
    }
  };
}

type ImportOutcome = 'imported' | 'skipped-already-synced' | 'skipped-no-mapping';

async function importExercise(
  context: IntegrationContext<GoogleHealthConfig>,
  exercise: GoogleHealthExercise,
  options: {
    projectByExerciseType: Map<string, string>;
    fallbackProjectId: string | undefined;
    syncTagId: string | undefined;
  }
): Promise<ImportOutcome> {
  const existing: MappingRecord | null = await context.mappings.findByExternal({
    system: PLUGIN_SYSTEM,
    entity: WORKOUT_ENTITY,
    externalId: exercise.id
  });
  if (existing) {
    return 'skipped-already-synced';
  }

  const projectId = (exercise.type && options.projectByExerciseType.get(exercise.type)) ?? options.fallbackProjectId;
  if (!projectId) {
    context.logger.info('No project mapped for exercise type — skipping', {
      exerciseId: exercise.id,
      type: exercise.type
    });
    return 'skipped-no-mapping';
  }

  const typeLabel = labelForExerciseType(exercise.type);
  const task = await context.data.createTask({
    projectId,
    startDateTime: exercise.startTime,
    endDateTime: exercise.endTime,
    description: `${typeLabel} (Google Health)`,
    tagIds: options.syncTagId ? [options.syncTagId] : undefined
  });

  await context.mappings.upsert({
    system: PLUGIN_SYSTEM,
    entity: WORKOUT_ENTITY,
    localId: task.id,
    externalId: exercise.id,
    externalLabel: typeLabel,
    metadata: {
      type: exercise.type ?? null,
      activeMinutes: exercise.activeMinutes ?? null,
      distance: exercise.distance ?? null,
      totalCalories: exercise.totalCalories ?? null,
      source: exercise.source?.name ?? null
    },
    syncStatus: 'SYNCED'
  });

  return 'imported';
}

function clampLookback(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return LOOKBACK_DAYS_DEFAULT;
  }
  return Math.min(LOOKBACK_DAYS_MAX, Math.max(LOOKBACK_DAYS_MIN, Math.trunc(value)));
}
