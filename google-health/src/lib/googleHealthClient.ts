import {
  GoogleHealthExercise,
  GoogleHealthIdentity,
  ListExercisesPage
} from './types';

interface GoogleHealthClientOptions {
  getAccessToken: () => Promise<string>;
  refreshAccessToken: () => Promise<string>;
}

interface ListExercisesParams {
  startTimeAfter?: string;
  pageToken?: string;
  pageSize?: number;
}

const PAGE_SIZE_DEFAULT = 200;

export class GoogleHealthClient {
  private static readonly API_BASE = 'https://health.googleapis.com';
  private static readonly REQUEST_TIMEOUT_MS = 30_000;
  private static readonly EXERCISE_DATA_TYPE = 'exercise';

  private readonly fetchAccessToken: () => Promise<string>;
  private readonly fetchRefreshedToken: () => Promise<string>;
  private cachedToken: string | null = null;

  constructor(options: GoogleHealthClientOptions) {
    this.fetchAccessToken = options.getAccessToken;
    this.fetchRefreshedToken = options.refreshAccessToken;
  }

  /** HTTP 200 from /identity → connected. We do not require the response body to carry a specific id. */
  async testConnection(): Promise<boolean> {
    const response = await this.request('GET', '/v4/users/me/identity');
    return response.ok;
  }

  async getIdentity(): Promise<GoogleHealthIdentity | null> {
    const response = await this.request('GET', '/v4/users/me/identity');
    if (!response.ok) {
      return null;
    }
    return (await this.readJson<GoogleHealthIdentity>(response)) ?? {};
  }

  async listExercises(params: ListExercisesParams = {}): Promise<ListExercisesPage> {
    const query = new URLSearchParams();
    query.set('pageSize', String(params.pageSize ?? PAGE_SIZE_DEFAULT));
    if (params.startTimeAfter) {
      // The reference spells filters in snake_case (start_time vs. endpoint kebab-case).
      query.set('filter', `start_time>${params.startTimeAfter}`);
    }
    if (params.pageToken) {
      query.set('pageToken', params.pageToken);
    }

    const path = `/v4/users/me/dataTypes/${GoogleHealthClient.EXERCISE_DATA_TYPE}/dataPoints?${query.toString()}`;
    const response = await this.request('GET', path);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Google Health listExercises failed (${response.status}): ${body}`);
    }

    const json = (await this.readJson<{
      dataPoints?: unknown[];
      nextPageToken?: string;
    }>(response)) ?? {};

    const exercises = Array.isArray(json.dataPoints)
      ? json.dataPoints
          .map((raw) => parseExercise(raw))
          .filter((ex): ex is GoogleHealthExercise => ex !== null)
      : [];

    return {
      exercises,
      nextPageToken: json.nextPageToken
    };
  }

  async *iterateExercises(params: ListExercisesParams = {}): AsyncGenerator<GoogleHealthExercise> {
    let pageToken: string | undefined = params.pageToken;
    do {
      const page = await this.listExercises({ ...params, pageToken });
      for (const exercise of page.exercises) {
        yield exercise;
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  }

  private async getAccessToken(): Promise<string> {
    if (this.cachedToken) {
      return this.cachedToken;
    }
    this.cachedToken = await this.fetchAccessToken();
    return this.cachedToken;
  }

  private async refreshAccessToken(): Promise<string> {
    this.cachedToken = null;
    this.cachedToken = await this.fetchRefreshedToken();
    return this.cachedToken;
  }

  private async request(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, retried = false): Promise<Response> {
    const token = await this.getAccessToken();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GoogleHealthClient.REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${GoogleHealthClient.API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(`Google Health request timed out after ${GoogleHealthClient.REQUEST_TIMEOUT_MS}ms`);
      }
      throw error;
    }
    clearTimeout(timeoutId);

    if (response.status === 401 && !retried) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed) {
        return this.request(method, path, body, true);
      }
    }
    return response;
  }

  private async readJson<T>(response: Response): Promise<T | null> {
    const text = await response.text();
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }
}

function parseExercise(raw: unknown): GoogleHealthExercise | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const point = raw as Record<string, unknown>;
  const id = typeof point.id === 'string' ? point.id : typeof point.name === 'string' ? point.name : null;
  const startTime = typeof point.startTime === 'string' ? point.startTime : null;
  const endTime = typeof point.endTime === 'string' ? point.endTime : null;
  if (!id || !startTime || !endTime) {
    return null;
  }

  // Google Health may nest exercise-specific fields under `exercise` or expose them at the root.
  const inner = (point.exercise && typeof point.exercise === 'object')
    ? (point.exercise as Record<string, unknown>)
    : point;

  const type = typeof inner.type === 'string' ? inner.type : undefined;
  const activeMinutes = typeof inner.activeMinutes === 'number' ? inner.activeMinutes : undefined;
  const distance = numericValue(inner.distance);
  const totalCalories = numericValue(inner.totalCalories);

  const source = point.source && typeof point.source === 'object'
    ? {
        name: typeof (point.source as Record<string, unknown>).name === 'string'
          ? ((point.source as Record<string, unknown>).name as string)
          : undefined,
        type: typeof (point.source as Record<string, unknown>).type === 'string'
          ? ((point.source as Record<string, unknown>).type as string)
          : undefined
      }
    : undefined;

  return { id, startTime, endTime, type, activeMinutes, distance, totalCalories, source };
}

function numericValue(raw: unknown): number | undefined {
  if (typeof raw === 'number') {
    return raw;
  }
  if (raw && typeof raw === 'object') {
    const v = (raw as Record<string, unknown>).value;
    if (typeof v === 'number') {
      return v;
    }
  }
  return undefined;
}
