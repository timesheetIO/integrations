import { TaskDto } from '@timesheet/integration-sdk';

export interface GoogleCalendarConfig {
  syncDirection?: 'bidirectional' | 'timesheet-to-google' | 'google-to-timesheet' | 'timesheet-to-external' | 'external-to-timesheet';
}

export interface GoogleCalendarDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface GoogleCalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  created?: string;
  updated?: string;
  start?: GoogleCalendarDateTime;
  end?: GoogleCalendarDateTime;
  etag?: string;
  extendedProperties?: {
    private?: Record<string, string>;
  };
}

export interface GoogleCalendarEventsResponse {
  items?: GoogleCalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

export interface GoogleCalendarListResponse {
  items?: Array<{ id: string; summary?: string; primary?: boolean }>;
  nextPageToken?: string;
}

export interface GoogleCalendarSyncInput {
  event?: string;
  triggerId?: string;
  taskId?: string;
  item?: Partial<TaskDto> & { taskId?: string; id?: string };
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  externalTaskId?: string;
  calendarId?: string;
}
