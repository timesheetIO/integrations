import { ExternalEntity } from '@timesheet/integration-sdk';
import {
  FreshBooksBusiness,
  FreshBooksCallback,
  FreshBooksCallbackResponse,
  FreshBooksCallbacksResponse,
  FreshBooksMeResponse,
  FreshBooksProject,
  FreshBooksProjectResponse,
  FreshBooksService,
  FreshBooksTeamMember,
  FreshBooksTimeEntry,
  FreshBooksTimeEntryResponse
} from './types';

interface FreshBooksClientOptions {
  getAccessToken: () => Promise<string>;
  refreshAccessToken: () => Promise<string>;
  /** Optional `business.id` override for multi-business identities. */
  businessId?: string;
}

export class FreshBooksClient {
  private static readonly BASE_URL = 'https://api.freshbooks.com';
  private static readonly REQUEST_TIMEOUT_MS = 30_000;
  private static readonly PAGE_SIZE = 100;

  private readonly fetchAccessToken: () => Promise<string>;
  private readonly fetchRefreshedToken: () => Promise<string>;
  private readonly businessIdOverride: string | undefined;
  private cachedToken: string | null = null;
  private resolvedBusiness: FreshBooksBusiness | null = null;
  // FreshBooks time entries reference a client, but only the project carries
  // the client relationship — cache project → client so outbound pushes don't
  // refetch the project on every task.
  private readonly projectClientCache = new Map<number, number>();

  constructor(options: FreshBooksClientOptions) {
    this.fetchAccessToken = options.getAccessToken;
    this.fetchRefreshedToken = options.refreshAccessToken;
    this.businessIdOverride = options.businessId;
  }

  // The access token is not scoped to a business; `/users/me` lists every
  // business the identity belongs to. Time Tracking, Projects, Services and
  // Team Members are keyed on `business.id`; Events (webhooks) on `account_id`.
  async resolveBusiness(): Promise<FreshBooksBusiness> {
    if (this.resolvedBusiness) {
      return this.resolvedBusiness;
    }
    const me = await this.request<FreshBooksMeResponse>('GET', '/auth/api/v1/users/me');
    const businesses = (me?.response?.business_memberships ?? [])
      .map((membership) => membership.business)
      .filter((business): business is FreshBooksBusiness => !!business?.id && !!business.account_id);

    if (businesses.length === 0) {
      throw new Error('FreshBooks: the connected identity has no business membership.');
    }

    let chosen = businesses[0];
    if (this.businessIdOverride) {
      const match = businesses.find((business) => String(business.id) === this.businessIdOverride);
      if (match) {
        chosen = match;
      }
    }
    this.resolvedBusiness = chosen;
    return chosen;
  }

  async businessId(): Promise<string> {
    return String((await this.resolveBusiness()).id);
  }

  async accountId(): Promise<string> {
    return (await this.resolveBusiness()).account_id;
  }

  async testConnection(): Promise<boolean> {
    const business = await this.resolveBusiness();
    return !!business?.id;
  }

  async listProjects(): Promise<ExternalEntity[]> {
    const bid = await this.businessId();
    const projects = await this.paginate<FreshBooksProject>(
      `/projects/business/${encodeURIComponent(bid)}/projects`,
      'projects',
      { active: 'true' }
    );
    return projects.map((project) => {
      if (project.id && typeof project.client_id === 'number') {
        this.projectClientCache.set(project.id, project.client_id);
      }
      return {
        id: String(project.id),
        name: project.title ?? String(project.id),
        clientId: typeof project.client_id === 'number' ? project.client_id : null,
        active: project.active ?? true
      };
    });
  }

  async getProject(projectId: string): Promise<FreshBooksProject | null> {
    const bid = await this.businessId();
    try {
      const response = await this.request<FreshBooksProjectResponse>(
        'GET',
        `/projects/business/${encodeURIComponent(bid)}/projects/${encodeURIComponent(projectId)}`
      );
      return response?.project ?? null;
    } catch (err) {
      if (String(err).includes('(404)')) {
        return null;
      }
      throw err;
    }
  }

  // The FreshBooks time entry needs the client id; only the project knows it.
  async resolveClientId(projectId: string): Promise<number | null> {
    const numericId = Number(projectId);
    if (Number.isFinite(numericId) && this.projectClientCache.has(numericId)) {
      return this.projectClientCache.get(numericId) ?? null;
    }
    const project = await this.getProject(projectId);
    if (project?.id && typeof project.client_id === 'number') {
      this.projectClientCache.set(project.id, project.client_id);
      return project.client_id;
    }
    return null;
  }

  async listTeamMembers(): Promise<ExternalEntity[]> {
    const bid = await this.businessId();
    const members = await this.paginateResponseArray<FreshBooksTeamMember>(
      `/auth/api/v1/businesses/${encodeURIComponent(bid)}/team_members`
    );
    return members
      .filter((member) => member.identity_id != null)
      .map((member) => ({
        id: String(member.identity_id),
        name:
          [member.first_name, member.last_name].filter(Boolean).join(' ').trim() ||
          member.email ||
          String(member.identity_id),
        active: member.active ?? true
      }));
  }

  async listServices(): Promise<ExternalEntity[]> {
    const bid = await this.businessId();
    const services = await this.paginate<FreshBooksService>(
      `/comments/business/${encodeURIComponent(bid)}/services`,
      'services',
      {}
    );
    return services
      .filter((service) => (service.vis_state ?? 0) === 0)
      .map((service) => ({
        id: String(service.id),
        name: service.name ?? String(service.id),
        billable: service.billable ?? true
      }));
  }

  async listTimeEntries(options?: { updatedSinceIso?: string }): Promise<FreshBooksTimeEntry[]> {
    const bid = await this.businessId();
    const query: Record<string, string> = {};
    if (options?.updatedSinceIso) {
      query.updated_since = options.updatedSinceIso;
    }
    return this.paginate<FreshBooksTimeEntry>(
      `/timetracking/business/${encodeURIComponent(bid)}/time_entries`,
      'time_entries',
      query
    );
  }

  async getTimeEntry(id: string): Promise<FreshBooksTimeEntry | null> {
    const bid = await this.businessId();
    try {
      const response = await this.request<FreshBooksTimeEntryResponse>(
        'GET',
        `/timetracking/business/${encodeURIComponent(bid)}/time_entries/${encodeURIComponent(id)}`
      );
      return response?.time_entry ?? null;
    } catch (err) {
      if (String(err).includes('(404)')) {
        return null;
      }
      throw err;
    }
  }

  async createTimeEntry(payload: Record<string, unknown>): Promise<FreshBooksTimeEntry> {
    const bid = await this.businessId();
    const response = await this.request<FreshBooksTimeEntryResponse>(
      'POST',
      `/timetracking/business/${encodeURIComponent(bid)}/time_entries`,
      undefined,
      { time_entry: payload }
    );
    if (!response?.time_entry?.id) {
      throw new Error('FreshBooks createTimeEntry did not return a time entry id.');
    }
    return response.time_entry;
  }

  async updateTimeEntry(id: string, payload: Record<string, unknown>): Promise<FreshBooksTimeEntry> {
    const bid = await this.businessId();
    const response = await this.request<FreshBooksTimeEntryResponse>(
      'PUT',
      `/timetracking/business/${encodeURIComponent(bid)}/time_entries/${encodeURIComponent(id)}`,
      undefined,
      { time_entry: payload }
    );
    if (!response?.time_entry?.id) {
      throw new Error('FreshBooks updateTimeEntry did not return a time entry id.');
    }
    return response.time_entry;
  }

  async deleteTimeEntry(id: string): Promise<void> {
    const bid = await this.businessId();
    await this.request<unknown>(
      'DELETE',
      `/timetracking/business/${encodeURIComponent(bid)}/time_entries/${encodeURIComponent(id)}`
    );
  }

  // ---- Webhook callbacks (Events API, keyed on account_id) ----

  async listCallbacks(): Promise<FreshBooksCallback[]> {
    const aid = await this.accountId();
    const response = await this.request<FreshBooksCallbacksResponse>(
      'GET',
      `/events/account/${encodeURIComponent(aid)}/events/callbacks`
    );
    return response?.response?.result?.callbacks ?? [];
  }

  async createCallback(event: string, uri: string): Promise<FreshBooksCallback | null> {
    const aid = await this.accountId();
    const response = await this.request<FreshBooksCallbackResponse>(
      'POST',
      `/events/account/${encodeURIComponent(aid)}/events/callbacks`,
      undefined,
      { callback: { event, uri } }
    );
    return response?.response?.result?.callback ?? null;
  }

  // Confirm ownership of a freshly created callback by echoing back the
  // verifier FreshBooks delivered to the callback URL.
  async verifyCallback(callbackId: string, verifier: string): Promise<void> {
    const aid = await this.accountId();
    await this.request<unknown>(
      'PUT',
      `/events/account/${encodeURIComponent(aid)}/events/callbacks/${encodeURIComponent(callbackId)}`,
      undefined,
      { callback: { verifier } }
    );
  }

  async deleteCallback(callbackId: string): Promise<void> {
    const aid = await this.accountId();
    await this.request<unknown>(
      'DELETE',
      `/events/account/${encodeURIComponent(aid)}/events/callbacks/${encodeURIComponent(callbackId)}`
    );
  }

  // ---- Internals ----

  private async paginate<T>(
    path: string,
    key: string,
    baseQuery: Record<string, string>
  ): Promise<T[]> {
    const out: T[] = [];
    let page = 1;
    while (true) {
      const response = await this.request<Record<string, unknown>>('GET', path, {
        ...baseQuery,
        page: String(page),
        per_page: String(FreshBooksClient.PAGE_SIZE)
      });
      const items = Array.isArray(response?.[key]) ? (response[key] as T[]) : [];
      out.push(...items);
      const meta = response?.meta as { pages?: number } | undefined;
      const pages = meta?.pages ?? 1;
      if (page >= pages || items.length === 0) {
        break;
      }
      page += 1;
    }
    return out;
  }

  // The Identity/Auth API returns list payloads under `response` (an array)
  // rather than a named resource key.
  private async paginateResponseArray<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let page = 1;
    while (true) {
      const response = await this.request<{ response?: T[]; meta?: { pages?: number } }>('GET', path, {
        page: String(page),
        per_page: String(FreshBooksClient.PAGE_SIZE)
      });
      const items = Array.isArray(response?.response) ? response.response : [];
      out.push(...items);
      const pages = response?.meta?.pages ?? 1;
      if (page >= pages || items.length === 0) {
        break;
      }
      page += 1;
    }
    return out;
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

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    query?: Record<string, string>,
    body?: unknown,
    retried = false
  ): Promise<T> {
    const token = await this.getAccessToken();
    const url = this.buildUrl(path, query);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FreshBooksClient.REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          // Required by the Projects and Time Tracking (alpha) endpoints.
          'Api-Version': 'alpha'
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(`FreshBooks API ${method} ${path} timed out after ${FreshBooksClient.REQUEST_TIMEOUT_MS}ms`);
      }
      throw error;
    }
    clearTimeout(timeoutId);

    if (response.status === 401 && !retried) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed) {
        return this.request<T>(method, path, query, body, true);
      }
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`FreshBooks API ${method} ${path} failed (${response.status}): ${errorBody}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private buildUrl(path: string, query?: Record<string, string>): string {
    const url = new URL(`${FreshBooksClient.BASE_URL}${path}`);
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
}
