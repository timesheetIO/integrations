export interface GoogleHealthConfig {
  /** Project ID used when an exercise type has no explicit mapping. Blank → skip unmapped types. */
  fallbackProjectId?: string;
  /** How far back to look on first sync (no `lastSyncTime` in state). Bounded 1–90, default 7. */
  lookbackDays?: number;
  /** Optional tag applied to every imported task for reporting. */
  syncTagId?: string;
}

export interface GoogleHealthIdentity {
  healthUserId?: string;
  fitbitUserId?: string;
  googleUserId?: string;
}

/**
 * Shape of an `exercise` data point from
 * GET /v4/users/me/dataTypes/exercise/dataPoints.
 *
 * The exact field names are not fully documented in the public API reference;
 * we accept the documented fields and tolerate unknown extras. Verify against
 * the live API and adjust the parser in googleHealthClient if needed.
 */
export interface GoogleHealthExercise {
  /** Unique data point id used for dedup. */
  id: string;
  /** ISO 8601. */
  startTime: string;
  /** ISO 8601. */
  endTime: string;
  /** e.g. 'RUN', 'YOGA', 'BIKE'. May be absent for free-form sessions. */
  type?: string;
  source?: {
    name?: string;
    type?: string;
  };
  /** Active minutes for the session. */
  activeMinutes?: number;
  /** Distance value (millimeters per Google Health unit convention). */
  distance?: number;
  /** Total calories burned. */
  totalCalories?: number;
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
