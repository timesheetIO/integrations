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

  constructor(options: GoogleCalendarClientOptions) {
    this.getAccessToken = options.getAccessToken;
    this.refreshAccessToken = options.refreshAccessToken;
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
    return this.request<GoogleCalendarEvent>(
      'PUT',
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

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
    body?: unknown,
    retried = false
  ): Promise<T> {
    const token = await this.getAccessToken();

    const response = await fetch(this.buildUrl(path, query), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });

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
