import { TaskDto } from '@timesheet/integration-sdk';

export interface MondayConfig {
  syncDirection?: 'bidirectional' | 'timesheet-to-monday' | 'monday-to-timesheet' | 'timesheet-to-external' | 'external-to-timesheet';
  webhookSecret?: string;
}

export interface MondayWorkspace {
  id: string;
  name: string;
}

export interface MondayBoard {
  id: string;
  name: string;
  state?: string;
  workspace?: { id?: string | null; name?: string | null } | null;
}

export interface MondayUser {
  id: string;
  name?: string | null;
  email?: string | null;
  enabled?: boolean | null;
  is_guest?: boolean | null;
}

export interface MondayColumnValue {
  id: string;
  type?: string;
  value?: string | null;
  text?: string | null;
}

export interface MondayItem {
  id: string;
  name?: string;
  state?: string;
  created_at?: string;
  updated_at?: string;
  board?: { id?: string; name?: string };
  parent_item?: { id?: string; board?: { id?: string } } | null;
  column_values?: MondayColumnValue[];
}

export interface MondayItemsPage {
  cursor?: string | null;
  items?: MondayItem[];
}

export interface MondayBoardItemsResponse {
  boards?: Array<{
    items_page?: MondayItemsPage;
  }>;
}

export interface MondayNextItemsResponse {
  next_items_page?: MondayItemsPage;
}

export interface MondayWebhookChallenge {
  challenge: string;
}

export interface MondayWebhookEvent {
  type?: string;
  boardId?: number | string;
  pulseId?: number | string;
  itemId?: number | string;
  columnId?: string;
  value?: unknown;
}

export interface MondayWebhookPayload {
  event?: MondayWebhookEvent;
  challenge?: string;
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
