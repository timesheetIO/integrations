export interface GoogleHealthConfig {
  /** Project ID used when an exercise type has no explicit mapping. Blank → skip unmapped types. */
  fallbackProjectId?: string;
  /** How far back to look on first sync (no `lastSyncTime` in state). Bounded 1–90, default 7. */
  lookbackDays?: number;
  /** Optional tag applied to every imported task for reporting. */
  syncTagId?: string;
}

/** GET /v4/users/me/identity returns the Fitbit legacy user id and the Google user id. */
export interface GoogleHealthIdentity {
  fitbitUserId?: string;
  googleUserId?: string;
}

/**
 * Normalized exercise session, mapped from an `exercise` data point of
 * GET /v4/users/me/dataTypes/exercise/dataPoints.
 *
 * Raw shape (see https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints):
 * DataPoint { name, dataSource: { recordingMethod, platform }, exercise: {
 *   interval: { startTime, endTime, startUtcOffset, endUtcOffset },
 *   exerciseType, displayName, activeDuration, metricsSummary: {
 *     caloriesKcal, distanceMillimeters, steps, ... } } }
 */
export interface GoogleHealthExercise {
  /** DataPoint resource name, used for dedup. */
  id: string;
  /** RFC 3339 timestamp from `exercise.interval.startTime`. */
  startTime: string;
  /** RFC 3339 timestamp from `exercise.interval.endTime`. */
  endTime: string;
  /** `exercise.exerciseType` enum value, e.g. 'RUNNING', 'YOGA', 'BIKING'. */
  exerciseType?: string;
  /** User-facing session name from `exercise.displayName`, when present. */
  displayName?: string;
  /** Protobuf Duration string from `exercise.activeDuration`, e.g. '1800s'. */
  activeDuration?: string;
  /** `exercise.metricsSummary.caloriesKcal`. */
  caloriesKcal?: number;
  /** `exercise.metricsSummary.distanceMillimeters`. */
  distanceMillimeters?: number;
  source?: {
    recordingMethod?: string;
    platform?: string;
  };
}

export interface ListExercisesPage {
  exercises: GoogleHealthExercise[];
  nextPageToken?: string;
}

export interface SyncResult {
  system: string;
  status: 'completed' | 'partial' | 'failed';
  syncedCount: number;
  details?: {
    imported?: number;
    skippedAlreadySynced?: number;
    skippedNoMapping?: number;
    sinceTime?: string;
    until?: string;
    errors?: Array<{ exerciseId: string; error: string }>;
  };
}
