import { TaskDto } from '@timesheet/integration-sdk';

export interface ClickUpConfig {
  syncDirection?: 'bidirectional' | 'timesheet-to-clickup' | 'clickup-to-timesheet' | 'timesheet-to-external' | 'external-to-timesheet';
  webhookSecret?: string;
}

export interface ClickUpUser {
  id: number | string;
  username?: string;
  email?: string;
  color?: string;
  profilePicture?: string;
  initials?: string;
}

export interface ClickUpMember {
  user?: ClickUpUser;
}

export interface ClickUpTeam {
  id: string;
  name: string;
  color?: string;
  avatar?: string;
  members?: ClickUpMember[];
}

export interface ClickUpSpace {
  id: string;
  name: string;
}

export interface ClickUpFolder {
  id: string;
  name: string;
  hidden?: boolean;
}

export interface ClickUpList {
  id: string;
  name: string;
  archived?: boolean;
  folder?: { id: string; name: string; hidden?: boolean };
  space?: { id: string; name: string };
}

export interface ClickUpTask {
  id: string;
  name?: string;
  description?: string;
  text_content?: string;
  status?: { status?: string; type?: string };
  date_created?: string;
  date_updated?: string;
  date_closed?: string | null;
  start_date?: string | null;
  due_date?: string | null;
  time_estimate?: number | null;
  url?: string;
  list?: { id: string; name?: string };
  team_id?: string;
  archived?: boolean;
}

export interface ClickUpTeamsResponse {
  teams?: ClickUpTeam[];
}

export interface ClickUpSpacesResponse {
  spaces?: ClickUpSpace[];
}

export interface ClickUpFoldersResponse {
  folders?: ClickUpFolder[];
}

export interface ClickUpListsResponse {
  lists?: ClickUpList[];
}

export interface ClickUpTasksResponse {
  tasks?: ClickUpTask[];
  last_page?: boolean;
}

export interface ClickUpTimeEntry {
  id: string;
  task?: { id: string; name?: string };
  wid?: string;
  user?: { id?: number | string; username?: string };
  billable?: boolean;
  start?: string | number;
  end?: string | number;
  duration?: string | number;
  description?: string;
  tags?: Array<{ name?: string }>;
  at?: string | number;
  source?: string;
}

export interface ClickUpTimeEntryEnvelope {
  data?: ClickUpTimeEntry | ClickUpTimeEntry[];
}

export interface ClickUpWebhookHistoryItem {
  event?: string;
  task_id?: string;
}

export interface ClickUpWebhookPayload {
  webhook_id?: string;
  event?: string;
  task_id?: string;
  history_items?: ClickUpWebhookHistoryItem[];
}

export interface SyncInput {
  event?: string;
  triggerId?: string;
  taskId?: string;
  todoId?: string;
  item?: Partial<TaskDto> & {
    taskId?: string;
    todoId?: string;
    id?: string;
    projectId?: string;
    name?: string;
    status?: number | { status?: string };
    estimatedHours?: number;
    estimatedMinutes?: number;
    dueDate?: string;
  };
  externalTaskId?: string;
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
}
