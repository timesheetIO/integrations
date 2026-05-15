import { ExternalEntity } from '@timesheet/integration-sdk';

/**
 * Curated set of common Google Health exercise types surfaced in the mapping UI.
 * Workouts whose `type` is not in this list still sync via the fallback project.
 *
 * `id` values match Google Health's `exercise.type` enum (uppercase, snake_case).
 */
export const CURATED_EXERCISE_TYPES: ExternalEntity[] = [
  { id: 'RUN', name: 'Running' },
  { id: 'WALK', name: 'Walking' },
  { id: 'BIKE', name: 'Cycling' },
  { id: 'SWIM', name: 'Swimming' },
  { id: 'YOGA', name: 'Yoga' },
  { id: 'STRENGTH_TRAINING', name: 'Strength Training' },
  { id: 'HIIT', name: 'HIIT' },
  { id: 'PILATES', name: 'Pilates' },
  { id: 'ELLIPTICAL', name: 'Elliptical' },
  { id: 'ROWING', name: 'Rowing' },
  { id: 'STAIR_CLIMBING', name: 'Stair Climbing' },
  { id: 'TENNIS', name: 'Tennis' },
  { id: 'GOLF', name: 'Golf' },
  { id: 'BASKETBALL', name: 'Basketball' },
  { id: 'SOCCER', name: 'Soccer' },
  { id: 'HIKING', name: 'Hiking' },
  { id: 'DANCE', name: 'Dance' },
  { id: 'MARTIAL_ARTS', name: 'Martial Arts' },
  { id: 'OTHER', name: 'Other / Unspecified' }
];

const LABEL_BY_ID = new Map<string, string>(
  CURATED_EXERCISE_TYPES.map((entity) => [entity.id, String(entity.name)])
);

/** Resolve the human-readable label for an exercise type id, falling back to a title-cased version. */
export function labelForExerciseType(type: string | undefined): string {
  if (!type) {
    return 'Workout';
  }
  const known = LABEL_BY_ID.get(type);
  if (known) {
    return known;
  }
  return type
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}
