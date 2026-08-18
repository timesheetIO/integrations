import { TaskDto, ToDoDto } from '@timesheet/integration-sdk';

export interface BasecampConfig {
  syncDirection?:
    | 'bidirectional'
    | 'timesheet-to-basecamp'
    | 'basecamp-to-timesheet'
    | 'timesheet-to-external'
    | 'external-to-timesheet';
  /** When 'off', Timesheet time entries are never written to Basecamp timesheets. */
  pushTimeEntries?: 'auto' | 'off';
  /** Name of the to-do list new to-dos are created in. Defaults to the first list in the project. */
  todoListName?: string;
}

export interface BasecampAccount {
  id: number;
  name?: string;
  product?: string;
  href?: string;
}

export interface BasecampAuthorization {
  identity?: { id?: number; email_address?: string; name?: string };
  accounts?: BasecampAccount[];
}

export interface BasecampRef {
  id: number;
  title?: string;
  name?: string;
  type?: string;
}

export interface BasecampDockEntry {
  id: number;
  title?: string;
  name?: string;
  enabled?: boolean;
  url?: string;
}

export interface BasecampProject {
  id: number;
  name?: string;
  description?: string | null;
  status?: string;
  updated_at?: string;
  /** Present on Basecamp accounts with the Timesheets add-on enabled for the project. */
  timesheet_enabled?: boolean;
  dock?: BasecampDockEntry[];
}

export interface BasecampTodolist {
  id: number;
  title?: string;
  name?: string;
  updated_at?: string;
}

export interface BasecampPerson {
  id: number;
  name?: string;
  email_address?: string;
  /** Clients cannot own timesheet entries, so they are never mapping candidates. */
  client?: boolean;
  employee?: boolean;
  admin?: boolean;
  owner?: boolean;
  title?: string;
}

export interface BasecampTodo {
  id: number;
  type?: string;
  status?: string;
  content?: string;
  description?: string | null;
  completed?: boolean;
  due_on?: string | null;
  starts_on?: string | null;
  created_at?: string;
  updated_at?: string;
  assignees?: BasecampPerson[];
  completion_subscribers?: BasecampPerson[];
  parent?: BasecampRef;
  bucket?: BasecampRef;
}

export interface BasecampTimesheetEntry {
  id: number;
  type?: string;
  status?: string;
  date?: string;
  /** Basecamp returns hours as a string, decimal ("1.5") or clock ("1:30"). */
  hours?: string | number;
  description?: string | null;
  created_at?: string;
  updated_at?: string;
  parent?: BasecampRef;
  bucket?: BasecampRef;
  person?: BasecampPerson;
}

export interface BasecampTimesheetEntryPayload {
  date: string;
  hours: string;
  description?: string;
  /**
   * The Basecamp person the time is for. Defaults to the authenticated user and
   * must be a non-client member of the project, so it is only sent when the
   * installation maps that Timesheet user to a Basecamp person.
   */
  person_id?: string;
}

export interface BasecampWebhook {
  id: number;
  active?: boolean;
  payload_url?: string;
  types?: string[];
}

/**
 * Basecamp webhook payload. Basecamp does not sign webhook deliveries, so the
 * `recording` here is treated as an untrusted hint: the handler refetches the
 * recording with the installation's own token before acting on it.
 */
export interface BasecampWebhookPayload {
  id?: number;
  kind?: string;
  created_at?: string;
  recording?: {
    id?: number;
    type?: string;
    status?: string;
    updated_at?: string;
    bucket?: BasecampRef;
  };
}

/** Discriminated payload from sync batches / direct invocations. */
export interface SyncInput {
  event?: string;
  triggerId?: string;
  /** Local Timesheet entity id (task or todo). */
  entityId?: string;
  /** Convenience alias kept for backwards compatibility with task-only callers. */
  taskId?: string;
  /** Inline payload carried by sync changes — shape depends on entityType. */
  item?:
    | (Partial<TaskDto> & {
        taskId?: string;
        id?: string;
        projectId?: string;
        userId?: string;
        todoId?: string;
      })
    | (Partial<ToDoDto> & {
        todoId?: string;
        id?: string;
        projectId?: string;
        userId?: string;
      });
  externalTaskId?: string;
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
}
