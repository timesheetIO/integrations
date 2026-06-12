import { ExternalEntity } from '@timesheet/integration-sdk';
import {
  GoogleCalendarEvent,
  GoogleCalendarEventsResponse,
  GoogleCalendarListResponse
} from './types';

interface GoogleCalendarClientOptions {
  getAccessToken: () => Promise<string>;
  refreshAccessToken: () => Promise<string>;
}

export class GoogleCalendarClient {
  private readonly getAccessToken: () => Promise<string>;
  private readonly refreshAccessToken: () => Promise<string>;
  private cachedToken: string | null = null;

  constructor(options: GoogleCalendarClientOptions) {
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
    const calendars = await this.listCalendars();
    return calendars.length > 0;
  }

  async listCalendars(): Promise<ExternalEntity[]> {
    const result: ExternalEntity[] = [];
    let pageToken: string | undefined;

    do {
      const response = await this.request<GoogleCalendarListResponse>('GET', '/users/me/calendarList', {
        pageToken
      });

      for (const item of response.items ?? []) {
        if (!item?.id) {
          continue;
        }
        result.push({
          id: item.id,
          name: item.summary ?? item.id,
          primary: item.primary ?? false
        });
      }

      pageToken = response.nextPageToken;
    } while (pageToken);

    return result;
  }

  async listEvents(
    calendarId: string,
    params: Record<string, string | number | boolean | undefined>
  ): Promise<GoogleCalendarEventsResponse> {
    return this.request<GoogleCalendarEventsResponse>(
      'GET',
      `/calendars/${encodeURIComponent(calendarId)}/events`,
      params
    );
  }

  async getEvent(calendarId: string, eventId: string): Promise<GoogleCalendarEvent | null> {
    try {
      return await this.request<GoogleCalendarEvent>(
        'GET',
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
      );
    } catch (error) {
      if (String(error).includes('(404)')) {
        return null;
      }
      throw error;
    }
  }

  async createEvent(calendarId: string, payload: Record<string, unknown>): Promise<GoogleCalendarEvent> {
    return this.request<GoogleCalendarEvent>(
      'POST',
      `/calendars/${encodeURIComponent(calendarId)}/events`,
      undefined,
      payload
    );
  }

  async updateEvent(calendarId: string, eventId: string, payload: Record<string, unknown>): Promise<GoogleCalendarEvent> {
    // PATCH (events.patch) only writes the fields in the payload. PUT
    // (events.update) replaces the whole event and clears everything not
    // sent — attendees, reminders, color — which destroys user-created events.
    return this.request<GoogleCalendarEvent>(
      'PATCH',
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      undefined,
      payload
    );
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    await this.request<void>(
      'DELETE',
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
    );
  }

  async watchEvents(calendarId: string, channelId: string, webhookUrl: string, ttlSeconds = 604800): Promise<{
    id?: string;
    resourceId?: string;
    expiration?: string;
  }> {
    return this.request<{ id?: string; resourceId?: string; expiration?: string }>(
      'POST',
      `/calendars/${encodeURIComponent(calendarId)}/events/watch`,
      undefined,
      {
        id: channelId,
        type: 'web_hook',
        address: webhookUrl,
        params: { ttl: String(ttlSeconds) }
      }
    );
  }

  async stopWatch(channelId: string, resourceId: string): Promise<void> {
    const token = await this.getAccessToken();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GoogleCalendarClient.REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch('https://www.googleapis.com/calendar/v3/channels/stop', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ id: channelId, resourceId }),
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(`Google Calendar API channels/stop timed out after ${GoogleCalendarClient.REQUEST_TIMEOUT_MS}ms`);
      }
      throw error;
    }
    clearTimeout(timeoutId);

    // 404 means channel already expired — not an error
    if (!response.ok && response.status !== 404) {
      const errorText = await response.text();
      throw new Error(`Google Calendar API channels/stop failed (${response.status}): ${errorText}`);
    }
  }

  private static readonly REQUEST_TIMEOUT_MS = 30_000;

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
    body?: unknown,
    retried = false
  ): Promise<T> {
    const token = await this.getAccessToken();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GoogleCalendarClient.REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(this.buildUrl(path, query), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(`Google Calendar API ${method} ${path} timed out after ${GoogleCalendarClient.REQUEST_TIMEOUT_MS}ms`);
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
      const errorText = await response.text();
      throw new Error(`Google Calendar API ${method} ${path} failed (${response.status}): ${errorText}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private buildUrl(path: string, query?: Record<string, string | number | boolean | undefined>): string {
    const url = new URL(`https://www.googleapis.com/calendar/v3${path}`);

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
