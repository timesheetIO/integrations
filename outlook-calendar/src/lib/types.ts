import { TaskDto } from '@timesheet/integration-sdk';

export interface OutlookCalendarConfig {
  syncDirection?: 'bidirectional' | 'timesheet-to-outlook' | 'outlook-to-timesheet' | 'timesheet-to-external' | 'external-to-timesheet';
}

export interface OutlookDateTimeTimeZone {
  dateTime?: string;
  timeZone?: string;
}

export interface OutlookExtendedProperty {
  id: string;
  value?: string;
}

export interface OutlookEvent {
  id: string;
  subject?: string;
  body?: { contentType?: string; content?: string };
  location?: { displayName?: string };
  start?: OutlookDateTimeTimeZone;
  end?: OutlookDateTimeTimeZone;
  isAllDay?: boolean;
  isCancelled?: boolean;
  type?: 'singleInstance' | 'occurrence' | 'exception' | 'seriesMaster';
  lastModifiedDateTime?: string;
  changeKey?: string;
  singleValueExtendedProperties?: OutlookExtendedProperty[];
  /** Present on delta items that were deleted or left the window. */
  '@removed'?: { reason?: string };
}

export interface OutlookCollection<T> {
  value?: T[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

export interface OutlookCalendar {
  id: string;
  name?: string;
  canEdit?: boolean;
  isDefaultCalendar?: boolean;
}

export interface OutlookSubscription {
  id: string;
  expirationDateTime?: string;
  resource?: string;
  notificationUrl?: string;
}

export interface OutlookNotification {
  subscriptionId?: string;
  clientState?: string;
  changeType?: string;
  resource?: string;
  resourceData?: { id?: string };
}

export interface OutlookCalendarSyncInput {
  event?: string;
  triggerId?: string;
  taskId?: string;
  item?: Partial<TaskDto> & { taskId?: string; id?: string };
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}
