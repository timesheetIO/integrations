import { ExternalEntity } from '@timesheet/integration-sdk';
import {
  BasecampAuthorization,
  BasecampProject,
  BasecampTimesheetEntry,
  BasecampTodo,
  BasecampTodolist,
  BasecampWebhook
} from './types';

interface BasecampClientOptions {
  getAccessToken: () => Promise<string>;
  refreshAccessToken: () => Promise<string>;
  /** Reads the account id cached by a previous invocation, avoiding a launchpad round trip. */
  loadCachedAccountId?: () => Promise<string | null>;
  /** Persists the resolved account id for the next invocation. */
  storeAccountId?: (accountId: string) => Promise<void>;
}

/** Basecamp rejects any request without a User-Agent naming the app and a contact. */
const USER_AGENT = 'Timesheet (https://timesheet.io)';
const LAUNCHPAD_AUTHORIZATION_URL = 'https://launchpad.37signals.com/authorization.json';
const API_HOST = 'https://3.basecampapi.com';
/** Basecamp's `product` discriminator for Basecamp 3 and later accounts. */
const BASECAMP_PRODUCT = 'bc3';
/** Cap on Retry-After so a long backoff can't outlive the invocation. */
const MAX_RETRY_AFTER_MS = 10_000;

/** A decoded response body plus the `rel="next"` URL from its Link header. */
interface LinkedResponse<T> {
  data: T;
  nextUrl: string | null;
}

export class BasecampClient {
  private static readonly REQUEST_TIMEOUT_MS = 30_000;
  private static readonly MAX_RATE_LIMIT_RETRIES = 3;

  private readonly fetchAccessToken: () => Promise<string>;
  private readonly fetchRefreshedToken: () => Promise<string>;
  private readonly loadCachedAccountId?: () => Promise<string | null>;
  private readonly storeAccountId?: (accountId: string) => Promise<void>;
  private cachedToken: string | null = null;
  private accountId: string | null = null;

  constructor(options: BasecampClientOptions) {
    this.fetchAccessToken = options.getAccessToken;
    this.fetchRefreshedToken = options.refreshAccessToken;
    this.loadCachedAccountId = options.loadCachedAccountId;
    this.storeAccountId = options.storeAccountId;
  }

  async getAuthorization(): Promise<BasecampAuthorization> {
    return this.requestAbsolute<BasecampAuthorization>('GET', LAUNCHPAD_AUTHORIZATION_URL);
  }

  async testConnection(): Promise<boolean> {
    const accountId = await this.resolveAccountId();
    return !!accountId;
  }

  /**
   * Basecamp's API host is account-scoped, so every call needs the account id
   * from launchpad. It is resolved once per invocation and cached in plugin
   * state so later invocations skip the round trip.
   */
  async resolveAccountId(): Promise<string> {
    if (this.accountId) {
      return this.accountId;
    }

    const cached = this.loadCachedAccountId ? await this.loadCachedAccountId() : null;
    if (cached) {
      this.accountId = cached;
      return cached;
    }

    const authorization = await this.getAuthorization();
    const account = (authorization.accounts ?? []).find((candidate) => candidate.product === BASECAMP_PRODUCT);
    if (!account?.id) {
      throw new Error('No Basecamp account found on this authorization. Reconnect the integration.');
    }

    this.accountId = String(account.id);
    if (this.storeAccountId) {
      await this.storeAccountId(this.accountId);
    }
    return this.accountId;
  }

  // --------------------------------------------------------------------------
  // Projects and to-do lists
  // --------------------------------------------------------------------------

  /** Full project payloads, which carry the `dock` and `timesheet_enabled` fields. */
  async listProjectRecords(): Promise<BasecampProject[]> {
    return this.paginate<BasecampProject>('/projects.json');
  }

  async listProjects(): Promise<ExternalEntity[]> {
    const projects = await this.listProjectRecords();
    return projects.map((project) => ({
      id: String(project.id),
      name: project.name ?? String(project.id),
      timesheetEnabled: project.timesheet_enabled ?? false
    }));
  }

  async getProject(projectId: string): Promise<BasecampProject | null> {
    return this.getOrNull<BasecampProject>(`/projects/${encodeURIComponent(projectId)}.json`);
  }

  async listTodolists(todosetId: string): Promise<BasecampTodolist[]> {
    return this.paginate<BasecampTodolist>(`/todosets/${encodeURIComponent(todosetId)}/todolists.json`);
  }

  // --------------------------------------------------------------------------
  // To-dos
  // --------------------------------------------------------------------------

  async getTodo(todoId: string): Promise<BasecampTodo | null> {
    return this.getOrNull<BasecampTodo>(`/todos/${encodeURIComponent(todoId)}.json`);
  }

  async createTodo(todolistId: string, payload: Record<string, unknown>): Promise<BasecampTodo> {
    const todo = await this.request<BasecampTodo>(
      'POST',
      `/todolists/${encodeURIComponent(todolistId)}/todos.json`,
      undefined,
      payload
    );
    if (!todo?.id) {
      throw new Error('Basecamp createTodo did not return a to-do id.');
    }
    return todo;
  }

  /**
   * Basecamp clears any field omitted from a to-do update, so callers must pass
   * the full field set, not just the changed keys.
   */
  async updateTodo(todoId: string, payload: Record<string, unknown>): Promise<BasecampTodo> {
    const todo = await this.request<BasecampTodo>(
      'PUT',
      `/todos/${encodeURIComponent(todoId)}.json`,
      undefined,
      payload
    );
    if (!todo?.id) {
      throw new Error('Basecamp updateTodo did not return a to-do id.');
    }
    return todo;
  }

  /** Completion is a subresource: it cannot be set through the to-do update payload. */
  async setTodoCompletion(todoId: string, completed: boolean): Promise<void> {
    await this.request<unknown>(
      completed ? 'POST' : 'DELETE',
      `/todos/${encodeURIComponent(todoId)}/completion.json`
    );
  }

  /** Basecamp has no hard delete for to-dos; trashing is the closest equivalent. */
  async trashRecording(recordingId: string): Promise<void> {
    await this.request<unknown>('PUT', `/recordings/${encodeURIComponent(recordingId)}/status/trashed.json`);
  }

  /**
   * To-do recordings across the given buckets, newest change first. Used for
   * incremental inbound sync: one paginated call covers every mapped project.
   */
  async listTodoRecordings(bucketIds: string[]): Promise<BasecampTodo[]> {
    if (bucketIds.length === 0) {
      return [];
    }
    return this.paginate<BasecampTodo>('/projects/recordings.json', {
      type: 'Todo',
      bucket: bucketIds.join(','),
      sort: 'updated_at',
      direction: 'desc'
    });
  }

  // --------------------------------------------------------------------------
  // Timesheet entries (Basecamp's paid Timesheets add-on)
  // --------------------------------------------------------------------------

  async listProjectTimesheetEntries(projectId: string): Promise<BasecampTimesheetEntry[]> {
    return this.paginate<BasecampTimesheetEntry>(`/projects/${encodeURIComponent(projectId)}/timesheet.json`);
  }

  async createTimesheetEntry(
    recordingId: string,
    payload: { date: string; hours: string; description?: string }
  ): Promise<BasecampTimesheetEntry> {
    const entry = await this.request<BasecampTimesheetEntry>(
      'POST',
      `/recordings/${encodeURIComponent(recordingId)}/timesheet/entries.json`,
      undefined,
      payload
    );
    if (!entry?.id) {
      throw new Error('Basecamp createTimesheetEntry did not return an entry id.');
    }
    return entry;
  }

  async updateTimesheetEntry(
    entryId: string,
    payload: Partial<{ date: string; hours: string; description: string }>
  ): Promise<BasecampTimesheetEntry> {
    const entry = await this.request<BasecampTimesheetEntry>(
      'PUT',
      `/timesheet_entries/${encodeURIComponent(entryId)}.json`,
      undefined,
      payload
    );
    if (!entry?.id) {
      throw new Error('Basecamp updateTimesheetEntry did not return an entry id.');
    }
    return entry;
  }

  async deleteTimesheetEntry(entryId: string): Promise<void> {
    try {
      await this.request<unknown>('DELETE', `/timesheet_entries/${encodeURIComponent(entryId)}.json`);
    } catch (err) {
      // Already gone is the desired end state, not a failure.
      if (!isStatus(err, 404)) {
        throw err;
      }
    }
  }

  // --------------------------------------------------------------------------
  // Webhooks (project-scoped)
  // --------------------------------------------------------------------------

  async listWebhooks(bucketId: string): Promise<BasecampWebhook[]> {
    return this.paginate<BasecampWebhook>(`/buckets/${encodeURIComponent(bucketId)}/webhooks.json`);
  }

  async createWebhook(bucketId: string, payloadUrl: string, types: string[]): Promise<BasecampWebhook> {
    const webhook = await this.request<BasecampWebhook>(
      'POST',
      `/buckets/${encodeURIComponent(bucketId)}/webhooks.json`,
      undefined,
      { payload_url: payloadUrl, types }
    );
    if (!webhook?.id) {
      throw new Error('Basecamp createWebhook did not return a webhook id.');
    }
    return webhook;
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    try {
      await this.request<unknown>('DELETE', `/webhooks/${encodeURIComponent(webhookId)}.json`);
    } catch (err) {
      if (!isStatus(err, 404)) {
        throw err;
      }
    }
  }

  // --------------------------------------------------------------------------
  // Transport
  // --------------------------------------------------------------------------

  private async getOrNull<T>(path: string): Promise<T | null> {
    try {
      return await this.request<T>('GET', path);
    } catch (err) {
      if (isStatus(err, 404) || isStatus(err, 403)) {
        return null;
      }
      throw err;
    }
  }

  /** Walks the `Link: <url>; rel="next"` chain Basecamp uses for pagination. */
  private async paginate<T>(path: string, query?: Record<string, string>): Promise<T[]> {
    const accountId = await this.resolveAccountId();
    let url: string | null = buildUrl(`${API_HOST}/${accountId}${path}`, query);
    const out: T[] = [];

    while (url) {
      const page: LinkedResponse<T[]> = await this.requestWithLink<T[]>('GET', url);
      if (Array.isArray(page.data)) {
        out.push(...page.data);
      }
      url = page.nextUrl;
    }
    return out;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    query?: Record<string, string>,
    body?: unknown
  ): Promise<T> {
    const accountId = await this.resolveAccountId();
    const url = buildUrl(`${API_HOST}/${accountId}${path}`, query);
    const { data } = await this.requestWithLink<T>(method, url, body);
    return data;
  }

  private async requestAbsolute<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string): Promise<T> {
    const { data } = await this.requestWithLink<T>(method, url);
    return data;
  }

  private async requestWithLink<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    body?: unknown,
    retriedAuth = false,
    rateLimitAttempt = 0
  ): Promise<LinkedResponse<T>> {
    const token = await this.getAccessToken();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), BasecampClient.REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timeoutId);
      // Matched by name rather than `instanceof DOMException`: the sandboxed
      // plugin isolate shims AbortController but defines no DOMException.
      if ((error as { name?: string })?.name === 'AbortError') {
        throw new Error(`Basecamp API ${method} ${url} timed out after ${BasecampClient.REQUEST_TIMEOUT_MS}ms`);
      }
      throw error;
    }
    clearTimeout(timeoutId);

    if (response.status === 401 && !retriedAuth) {
      await this.refreshAccessToken();
      return this.requestWithLink<T>(method, url, body, true, rateLimitAttempt);
    }

    // Basecamp rate-limits per IP, which the shared plugin runtime pool hits
    // collectively — honour Retry-After rather than failing the whole sync.
    if (response.status === 429 && rateLimitAttempt < BasecampClient.MAX_RATE_LIMIT_RETRIES) {
      const waitMs = parseRetryAfterMs(readHeader(response, 'retry-after'));
      await delay(waitMs);
      return this.requestWithLink<T>(method, url, body, retriedAuth, rateLimitAttempt + 1);
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Basecamp API ${method} ${url} failed (${response.status}): ${errorBody}`);
    }

    if (response.status === 204) {
      return { data: undefined as T, nextUrl: null };
    }

    const data = (await response.json()) as T;
    return { data, nextUrl: parseNextLink(readHeader(response, 'link')) };
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
}

function buildUrl(base: string, query?: Record<string, string>): string {
  const url = new URL(base);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') {
        continue;
      }
      url.searchParams.append(key, String(value));
    }
  }
  return url.toString();
}

/** Header access guarded for runtimes whose Response stub omits `headers.get`. */
function readHeader(response: Response, name: string): string | null {
  const headers = response.headers as unknown as { get?: (key: string) => string | null };
  return typeof headers?.get === 'function' ? headers.get(name) : null;
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) {
    return null;
  }
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (match) {
      return match[1];
    }
  }
  return null;
}

function parseRetryAfterMs(retryAfter: string | null): number {
  const seconds = Number(retryAfter);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 1_000;
  }
  return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isStatus(err: unknown, status: number): boolean {
  return String(err).includes(`(${status})`);
}
