import { TaskDto, ToDoDto } from '@timesheet/integration-sdk';

export interface AsanaConfig {
  syncDirection?:
    | 'bidirectional'
    | 'timesheet-to-asana'
    | 'asana-to-timesheet'
    | 'timesheet-to-external'
    | 'external-to-timesheet';
  workspaceId?: string;
  defaultAssignee?: string;
  webhookSecret?: string;
}

export interface AsanaCompactRef {
  gid: string;
  name?: string;
  resource_type?: string;
}

export interface AsanaWorkspace {
  gid: string;
  name?: string;
  resource_type?: string;
}

export interface AsanaProject {
  gid: string;
  name?: string;
  archived?: boolean;
  workspace?: AsanaCompactRef;
  team?: AsanaCompactRef;
  resource_type?: string;
}

export interface AsanaTask {
  gid: string;
  name?: string;
  notes?: string;
  completed?: boolean;
  completed_at?: string | null;
  created_at?: string;
  modified_at?: string;
  due_at?: string | null;
  due_on?: string | null;
  start_at?: string | null;
  start_on?: string | null;
  assignee?: AsanaCompactRef | null;
  projects?: AsanaCompactRef[];
  workspace?: AsanaCompactRef;
  resource_type?: string;
}

export interface AsanaTimeTrackingEntry {
  gid: string;
  duration_minutes?: number;
  entered_on?: string;
  created_at?: string;
  created_by?: AsanaCompactRef | null;
  task?: AsanaCompactRef;
  resource_type?: string;
}

export interface AsanaPagedResponse<T> {
  data: T[];
  next_page?: {
    offset?: string;
    path?: string;
    uri?: string;
  } | null;
}

export interface AsanaSingleResponse<T> {
  data: T;
}

export interface AsanaWebhookEvent {
  resource?: {
    gid?: string;
    resource_type?: string;
    resource_subtype?: string;
  };
  parent?: {
    gid?: string;
    resource_type?: string;
  } | null;
  action?: 'changed' | 'added' | 'removed' | 'deleted' | 'undeleted';
  change?: {
    field?: string;
    action?: string;
  };
  created_at?: string;
  user?: {
    gid?: string;
  } | null;
}

export interface AsanaWebhookPayload {
  events?: AsanaWebhookEvent[];
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
