import { ExternalEntity } from '@timesheet/integration-sdk';
import {
  OutlookCalendar,
  OutlookCollection,
  OutlookEvent,
  OutlookSubscription
} from './types';

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

/**
 * Named string property that stamps an event with the Timesheet task id, the
 * Graph counterpart of Google's private extended property. The GUID is ours
 * and must never change, or existing stamps stop matching.
 */
export const TIMESHEET_ID_PROPERTY = 'String {6f7d3f2c-1b8e-4f3a-9c5d-2e4b7a9d1c30} Name timesheetId';

// Times come back as UTC wall clocks, bodies as plain text, and event ids stay
// the same when an event moves to another calendar.
const PREFERENCES = 'outlook.timezone="UTC", outlook.body-content-type="text", IdType="ImmutableId"';
const EXPAND_STAMP = `singleValueExtendedProperties($filter=id eq '${TIMESHEET_ID_PROPERTY}')`;

interface OutlookCalendarClientOptions {
  getAccessToken: () => Promise<string>;
  refreshAccessToken: () => Promise<string>;
}

export class GraphRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

export class OutlookCalendarClient {
  private static readonly REQUEST_TIMEOUT_MS = 30_000;
  /** Longest Retry-After we wait for inside one execution; longer throttling fails the run. */
  private static readonly MAX_RETRY_AFTER_MS = 20_000;

  private readonly getAccessToken: () => Promise<string>;
  private readonly refreshAccessToken: () => Promise<string>;
  private cachedToken: string | null = null;

  constructor(options: OutlookCalendarClientOptions) {
    this.getAccessToken = async () => {
      if (this.cachedToken) return this.cachedToken;
      this.cachedToken = await options.getAccessToken();
      return this.cachedToken;
    };
    this.refreshAccessToken = async () => {
      this.cachedToken = null;
      this.cachedToken = await options.refreshAccessToken();
      return this.cachedToken;
    };
  }

  async testConnection(): Promise<boolean> {
    await this.request<OutlookCollection<OutlookCalendar>>('GET', '/me/calendars', { $top: 1, $select: 'id' });
    return true;
  }

  async listCalendars(): Promise<ExternalEntity[]> {
    const result: ExternalEntity[] = [];
    let url: string | undefined = this.buildUrl('/me/calendars', {
      $select: 'id,name,canEdit,isDefaultCalendar',
      $top: 100
    });

    while (url) {
      const page: OutlookCollection<OutlookCalendar> = await this.request('GET', url);
      for (const calendar of page.value ?? []) {
        if (!calendar?.id) {
          continue;
        }
        result.push({
          id: calendar.id,
          name: calendar.name ?? calendar.id,
          primary: calendar.isDefaultCalendar ?? false,
          canEdit: calendar.canEdit ?? false
        });
      }
      url = page['@odata.nextLink'];
    }

    return result;
  }

  /**
   * One page of the calendar's change feed. Without a link this starts a new
   * feed over the window; afterwards pass the nextLink or deltaLink returned.
   */
  async deltaPage(
    calendarId: string,
    link: string | undefined,
    window: { start: string; end: string }
  ): Promise<OutlookCollection<OutlookEvent>> {
    const url = link ?? this.buildUrl(`/me/calendars/${encodeURIComponent(calendarId)}/calendarView/delta`, {
      startDateTime: window.start,
      endDateTime: window.end
    });
    return this.request('GET', url, undefined, undefined, { Prefer: `${PREFERENCES}, odata.maxpagesize=100` });
  }

  /** The event with its Timesheet stamp, or null when it no longer exists. */
  async getEvent(eventId: string): Promise<OutlookEvent | null> {
    try {
      return await this.request<OutlookEvent>('GET', `/me/events/${encodeURIComponent(eventId)}`, {
        $expand: EXPAND_STAMP
      });
    } catch (error) {
      if (error instanceof GraphRequestError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /** An event stamped with the task id anywhere in the user's mailbox. */
  async findEventByTimesheetId(taskId: string): Promise<OutlookEvent | null> {
    const response = await this.request<OutlookCollection<OutlookEvent>>('GET', '/me/events', {
      $filter: `singleValueExtendedProperties/Any(ep: ep/id eq '${TIMESHEET_ID_PROPERTY}' and ep/value eq '${escapeODataString(taskId)}')`,
      $top: 1
    });
    return response.value?.[0] ?? null;
  }

  async createEvent(calendarId: string, payload: Record<string, unknown>): Promise<OutlookEvent> {
    return this.request<OutlookEvent>(
      'POST',
      `/me/calendars/${encodeURIComponent(calendarId)}/events`,
      undefined,
      payload
    );
  }

  /** PATCH writes only the fields in the payload; everything else on the event stays. */
  async updateEvent(eventId: string, payload: Record<string, unknown>): Promise<OutlookEvent> {
    return this.request<OutlookEvent>(
      'PATCH',
      `/me/events/${encodeURIComponent(eventId)}`,
      undefined,
      payload
    );
  }

  async deleteEvent(eventId: string): Promise<void> {
    try {
      await this.request<void>('DELETE', `/me/events/${encodeURIComponent(eventId)}`);
    } catch (error) {
      // Already gone in Outlook.
      if (error instanceof GraphRequestError && error.status === 404) {
        return;
      }
      throw error;
    }
  }

  async listSubscriptions(): Promise<OutlookSubscription[]> {
    const result: OutlookSubscription[] = [];
    let url: string | undefined = this.buildUrl('/subscriptions');
    while (url) {
      const page: OutlookCollection<OutlookSubscription> = await this.request('GET', url);
      result.push(...(page.value ?? []));
      url = page['@odata.nextLink'];
    }
    return result;
  }

  /** Mailbox-wide: Graph documents event subscriptions only for all of the user's events. */
  async createSubscription(input: {
    notificationUrl: string;
    clientState: string;
    expirationDateTime: string;
  }): Promise<OutlookSubscription> {
    return this.request<OutlookSubscription>('POST', '/subscriptions', undefined, {
      changeType: 'created,updated,deleted',
      notificationUrl: input.notificationUrl,
      resource: 'me/events',
      expirationDateTime: input.expirationDateTime,
      clientState: input.clientState
    });
  }

  /** The renewed subscription, or null when Graph no longer knows it. */
  async renewSubscription(subscriptionId: string, expirationDateTime: string): Promise<OutlookSubscription | null> {
    try {
      return await this.request<OutlookSubscription>(
        'PATCH',
        `/subscriptions/${encodeURIComponent(subscriptionId)}`,
        undefined,
        { expirationDateTime }
      );
    } catch (error) {
      if (error instanceof GraphRequestError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async deleteSubscription(subscriptionId: string): Promise<void> {
    try {
      await this.request<void>('DELETE', `/subscriptions/${encodeURIComponent(subscriptionId)}`);
    } catch (error) {
      if (error instanceof GraphRequestError && error.status === 404) {
        return;
      }
      throw error;
    }
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    pathOrUrl: string,
    query?: Record<string, string | number | boolean | undefined>,
    body?: unknown,
    extraHeaders?: Record<string, string>,
    attempt = 0
  ): Promise<T> {
    const url = pathOrUrl.startsWith('https://') ? pathOrUrl : this.buildUrl(pathOrUrl, query);
    const token = await this.getAccessToken();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OutlookCalendarClient.REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Prefer: PREFERENCES,
          ...extraHeaders
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
    } catch (error) {
      if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(`Microsoft Graph ${method} ${describe(url)} timed out after ${OutlookCalendarClient.REQUEST_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.status === 401 && attempt === 0) {
      await this.refreshAccessToken();
      return this.request<T>(method, url, undefined, body, extraHeaders, attempt + 1);
    }

    if ((response.status === 429 || response.status === 503) && attempt < 2) {
      const waitMs = retryAfterMs(response);
      if (waitMs <= OutlookCalendarClient.MAX_RETRY_AFTER_MS) {
        await new Promise(resolve => setTimeout(resolve, waitMs));
        return this.request<T>(method, url, undefined, body, extraHeaders, attempt + 1);
      }
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new GraphRequestError(
        `Microsoft Graph ${method} ${describe(url)} failed (${response.status}): ${errorText}`,
        response.status,
        readErrorCode(errorText)
      );
    }

    if (response.status === 202 || response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private buildUrl(path: string, query?: Record<string, string | number | boolean | undefined>): string {
    const url = new URL(`${GRAPH_BASE_URL}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') {
        continue;
      }
      url.searchParams.append(key, String(value));
    }
    return url.toString();
  }
}

function retryAfterMs(response: Response): number {
  const header = response.headers?.get?.('Retry-After');
  const seconds = header ? Number(header) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 5_000;
}

function readErrorCode(errorText: string): string | undefined {
  try {
    return (JSON.parse(errorText) as { error?: { code?: string } })?.error?.code;
  } catch {
    return undefined;
  }
}

/** The request path without query values: delta links carry opaque state tokens. */
function describe(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split('?')[0];
  }
}

function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}
