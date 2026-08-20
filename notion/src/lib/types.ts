import { TaskDto, ToDoDto } from '@timesheet/integration-sdk';

export interface NotionConfig {
  syncDirection?:
    | 'bidirectional'
    | 'timesheet-to-notion'
    | 'notion-to-timesheet'
    | 'timesheet-to-external'
    | 'external-to-timesheet';
  /**
   * Notion database id of the time-log database. When set, Timesheet tasks
   * (time entries) sync as rows of this database; when unset, only todos sync.
   */
  timeLogDatabaseId?: string;
  /**
   * Name for a time-log row when the time entry has no description. Placeholders:
   * {projectTitle}, {startDate}, {startTime}, {endDate}, {endTime}, {taskId}.
   */
  timeLogNameTemplate?: string;
  /** Optional property-name override for the todo status property. */
  statusProperty?: string;
  /** Optional property-name override for the todo due-date property. */
  dueDateProperty?: string;
  /** Fallback webhook verifier; normally captured during the webhook handshake. */
  webhookSecret?: string;
}

export interface NotionRichText {
  type?: string;
  plain_text?: string;
  text?: { content?: string };
}

export interface NotionSelectOption {
  id?: string;
  name?: string;
  color?: string;
}

export interface NotionStatusGroup {
  id?: string;
  name?: string;
  option_ids?: string[];
}

// One entry of a database's `properties` schema. Only the types the plugin
// consumes are modeled; the rest stay opaque.
export interface NotionPropertySchema {
  id?: string;
  name?: string;
  type?: string;
  status?: {
    options?: NotionSelectOption[];
    groups?: NotionStatusGroup[];
  };
}

export interface NotionDatabase {
  id: string;
  archived?: boolean;
  title?: NotionRichText[];
  properties?: Record<string, NotionPropertySchema>;
}

// One entry of a page's `properties` map (value side, not schema side).
export interface NotionPropertyValue {
  id?: string;
  type?: string;
  title?: NotionRichText[];
  rich_text?: NotionRichText[];
  checkbox?: boolean;
  status?: { id?: string; name?: string };
  date?: { start?: string | null; end?: string | null };
  number?: number | null;
  relation?: Array<{ id?: string }>;
}

export interface NotionPage {
  id: string;
  archived?: boolean;
  in_trash?: boolean;
  created_time?: string;
  // Minute precision: Notion truncates seconds, so equal timestamps do not
  // imply equal content. See the staleness handling in taskSync.
  last_edited_time?: string;
  parent?: { type?: string; database_id?: string; page_id?: string };
  /** Who created the page. A page written by this plugin carries the bot user. */
  created_by?: { object?: string; id?: string };
  properties?: Record<string, NotionPropertyValue>;
}

export interface NotionUser {
  id: string;
  name?: string;
  type?: string;
  person?: { email?: string };
}

export interface NotionListResponse<T> {
  object?: string;
  results?: T[];
  has_more?: boolean;
  next_cursor?: string | null;
}

// Webhook delivery. The one-time subscription handshake carries only
// `verification_token`; regular events carry `type` + `entity`.
export interface NotionWebhookPayload {
  id?: string;
  timestamp?: string;
  workspace_id?: string;
  subscription_id?: string;
  type?: string;
  verification_token?: string;
  entity?: { id?: string; type?: string };
  data?: {
    parent?: { id?: string; type?: string };
    updated_properties?: unknown[];
  };
}

/**
 * Resolved property names of a mapped database, discovered from its schema and
 * cached in plugin state (monday board-columns pattern). `titleName` always
 * resolves; the rest are optional depending on the database layout.
 */
export interface ResolvedDatabaseProps {
  titleName: string;
  statusName?: string;
  statusType?: 'status' | 'checkbox';
  /** Option written when a todo (re)opens; first option of the To-do group. */
  openOption?: string;
  /** Option written when a todo closes; first option of the Complete group. */
  doneOption?: string;
  /** Option ids of the Complete group, for reading status back. */
  completeOptionIds?: string[];
  dateName?: string;
  /** Time-log databases only. */
  numberName?: string;
  relationName?: string;
}

export interface SyncInput {
  event?: string;
  triggerId?: string;
  taskId?: string;
  entityId?: string;
  item?: (Partial<TaskDto> & Partial<ToDoDto>) & {
    taskId?: string;
    todoId?: string;
    id?: string;
    projectId?: string;
    userId?: string;
  };
  externalTaskId?: string;
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
  /** Set by the backend on webhooks it has already verified and routed. */
  verified?: boolean;
}
