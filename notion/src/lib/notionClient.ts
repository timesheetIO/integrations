import { ExternalEntity } from '@timesheet/integration-sdk';
import {
  NotionDatabase,
  NotionListResponse,
  NotionPage,
  NotionUser
} from './types';

interface NotionClientOptions {
  getAccessToken: () => Promise<string>;
  refreshAccessToken: () => Promise<string>;
}

export class NotionClient {
  private static readonly BASE_URL = 'https://api.notion.com';
  // Pinned API version: keeps the classic database endpoints (`/v1/databases`)
  // rather than the 2025 data-source split.
  private static readonly NOTION_VERSION = '2022-06-28';
  private static readonly REQUEST_TIMEOUT_MS = 30_000;
  private static readonly PAGE_SIZE = 100;
  // Notion rate-limits at ~3 requests/second; retry 429s a couple of times
  // honoring Retry-After before giving up.
  private static readonly MAX_RATE_LIMIT_RETRIES = 2;

  private readonly fetchAccessToken: () => Promise<string>;
  private readonly fetchRefreshedToken: () => Promise<string>;
  private cachedToken: string | null = null;

  constructor(options: NotionClientOptions) {
    this.fetchAccessToken = options.getAccessToken;
    this.fetchRefreshedToken = options.refreshAccessToken;
  }

  async testConnection(): Promise<boolean> {
    const me = await this.request<NotionUser>('GET', '/v1/users/me');
    return !!me?.id;
  }

  async getBotUser(): Promise<NotionUser | null> {
    const me = await this.request<NotionUser>('GET', '/v1/users/me');
    return me?.id ? me : null;
  }

  /**
   * People in the workspace. Bots are filtered out: only a person can be the
   * human author of a time log, and the integration's own bot is what pages it
   * wrote are created by.
   */
  async listUsers(): Promise<ExternalEntity[]> {
    const out: ExternalEntity[] = [];
    let cursor: string | undefined;
    do {
      const query: Record<string, string> = { page_size: String(NotionClient.PAGE_SIZE) };
      if (cursor) {
        query.start_cursor = cursor;
      }
      const response = await this.request<NotionListResponse<NotionUser>>('GET', '/v1/users', query);
      for (const user of response?.results ?? []) {
        if (!user?.id || user.type === 'bot') {
          continue;
        }
        out.push({
          id: user.id,
          name: user.name ?? user.person?.email ?? user.id,
          email: user.person?.email ?? ''
        });
      }
      cursor = response?.has_more && response.next_cursor ? response.next_cursor : undefined;
    } while (cursor);
    return out;
  }

  // Only databases the user shared with the integration during OAuth are
  // visible to search — that selection step is Notion's permission model.
  async searchDatabases(): Promise<ExternalEntity[]> {
    const out: ExternalEntity[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.request<NotionListResponse<NotionDatabase>>('POST', '/v1/search', undefined, {
        filter: { property: 'object', value: 'database' },
        page_size: NotionClient.PAGE_SIZE,
        ...(cursor ? { start_cursor: cursor } : {})
      });
      for (const database of response?.results ?? []) {
        if (!database?.id || database.archived) {
          continue;
        }
        out.push({
          id: database.id,
          name: richTextToPlain(database.title) || database.id
        });
      }
      cursor = response?.has_more ? response?.next_cursor ?? undefined : undefined;
    } while (cursor);
    return out;
  }

  async getDatabase(databaseId: string): Promise<NotionDatabase | null> {
    try {
      const response = await this.request<NotionDatabase>(
        'GET',
        `/v1/databases/${encodeURIComponent(databaseId)}`
      );
      return response?.id ? response : null;
    } catch (err) {
      if (String(err).includes('(404)')) {
        return null;
      }
      throw err;
    }
  }

  async queryDatabase(databaseId: string, options?: { editedSinceIso?: string }): Promise<NotionPage[]> {
    const out: NotionPage[] = [];
    let cursor: string | undefined;
    do {
      const body: Record<string, unknown> = {
        page_size: NotionClient.PAGE_SIZE,
        ...(cursor ? { start_cursor: cursor } : {})
      };
      if (options?.editedSinceIso) {
        body.filter = {
          timestamp: 'last_edited_time',
          last_edited_time: { on_or_after: options.editedSinceIso }
        };
      }
      const response = await this.request<NotionListResponse<NotionPage>>(
        'POST',
        `/v1/databases/${encodeURIComponent(databaseId)}/query`,
        undefined,
        body
      );
      out.push(...(response?.results ?? []));
      cursor = response?.has_more ? response?.next_cursor ?? undefined : undefined;
    } while (cursor);
    return out;
  }

  async getPage(pageId: string): Promise<NotionPage | null> {
    try {
      const response = await this.request<NotionPage>('GET', `/v1/pages/${encodeURIComponent(pageId)}`);
      return response?.id ? response : null;
    } catch (err) {
      if (String(err).includes('(404)')) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Creates a database as a child of a page. Notion refuses the workspace root as a
   * parent, so callers have to supply a real page.
   */
  async createDatabase(
    parentPageId: string,
    title: string,
    properties: Record<string, unknown>
  ): Promise<NotionDatabase> {
    const response = await this.request<NotionDatabase>('POST', '/v1/databases', undefined, {
      parent: { type: 'page_id', page_id: parentPageId },
      title: [{ type: 'text', text: { content: title } }],
      properties
    });
    if (!response?.id) {
      throw new Error('Notion createDatabase returned no database id.');
    }
    return response;
  }

  async createPage(databaseId: string, properties: Record<string, unknown>): Promise<NotionPage> {
    const response = await this.request<NotionPage>('POST', '/v1/pages', undefined, {
      parent: { database_id: databaseId },
      properties
    });
    if (!response?.id) {
      throw new Error('Notion createPage did not return a page id.');
    }
    return response;
  }

  async updatePage(pageId: string, properties?: Record<string, unknown>): Promise<NotionPage> {
    const response = await this.request<NotionPage>(
      'PATCH',
      `/v1/pages/${encodeURIComponent(pageId)}`,
      undefined,
      { properties: properties ?? {} }
    );
    if (!response?.id) {
      throw new Error('Notion updatePage did not return a page id.');
    }
    return response;
  }

  // Notion has no hard delete via API; archiving moves the page to trash.
  async archivePage(pageId: string): Promise<void> {
    await this.request<NotionPage>(
      'PATCH',
      `/v1/pages/${encodeURIComponent(pageId)}`,
      undefined,
      { archived: true }
    );
  }

  // ---- Internals ----

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
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    query?: Record<string, string>,
    body?: unknown,
    retriedAuth = false,
    rateLimitRetries = 0
  ): Promise<T> {
    const token = await this.getAccessToken();
    const url = this.buildUrl(path, query);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), NotionClient.REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Notion-Version': NotionClient.NOTION_VERSION
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(`Notion API ${method} ${path} timed out after ${NotionClient.REQUEST_TIMEOUT_MS}ms`);
      }
      throw error;
    }
    clearTimeout(timeoutId);

    if (response.status === 401 && !retriedAuth) {
      // Notion access tokens do not expire, so a refresh is usually a no-op or
      // unsupported; tolerate a failing refresh and surface the original 401.
      try {
        const refreshed = await this.refreshAccessToken();
        if (refreshed) {
          return this.request<T>(method, path, query, body, true, rateLimitRetries);
        }
      } catch {
        // Fall through to the error below.
      }
    }

    if (response.status === 429 && rateLimitRetries < NotionClient.MAX_RATE_LIMIT_RETRIES) {
      const waitMs = this.retryAfterMs(response);
      await delay(waitMs);
      return this.request<T>(method, path, query, body, retriedAuth, rateLimitRetries + 1);
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Notion API ${method} ${path} failed (${response.status}): ${errorBody}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private retryAfterMs(response: Response): number {
    const headers = response.headers as { get?: (name: string) => string | null } | undefined;
    const raw = typeof headers?.get === 'function' ? headers.get('retry-after') : null;
    const seconds = raw ? Number(raw) : NaN;
    return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 30) * 1000 : 1000;
  }

  private buildUrl(path: string, query?: Record<string, string>): string {
    const url = new URL(`${NotionClient.BASE_URL}${path}`);
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

export function richTextToPlain(richText: Array<{ plain_text?: string; text?: { content?: string } }> | undefined): string {
  return (richText ?? [])
    .map((part) => part.plain_text ?? part.text?.content ?? '')
    .join('')
    .trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
