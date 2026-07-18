import { TaskDto } from '@timesheet/integration-sdk';

export interface FreshBooksConfig {
  syncDirection?:
    | 'bidirectional'
    | 'timesheet-to-freshbooks'
    | 'freshbooks-to-timesheet'
    | 'timesheet-to-external'
    | 'external-to-timesheet';
  /**
   * Optional override selecting which FreshBooks business to sync when the
   * connected identity belongs to more than one. Matches `business.id`.
   */
  businessId?: string;
  /** Fallback webhook verifier; normally captured during the callback handshake. */
  webhookSecret?: string;
}

export interface FreshBooksTimer {
  id?: number;
  is_running?: boolean;
}

// Time Tracking API entity. Durations are in seconds; started_at is UTC.
// Note: FreshBooks does not expose an `updated_at` on time entries — only
// `created_at` and an `updated_since` list filter — so inbound echo detection
// relies on content comparison rather than an external update timestamp.
export interface FreshBooksTimeEntry {
  id: number;
  is_logged?: boolean;
  duration?: number;
  note?: string;
  started_at?: string;
  created_at?: string;
  client_id?: number;
  project_id?: number;
  service_id?: number;
  identity_id?: number;
  active?: boolean;
  billable?: boolean;
  billed?: boolean;
  internal?: boolean;
  retainer_id?: number;
  timer?: FreshBooksTimer;
}

export interface FreshBooksProject {
  id: number;
  title?: string;
  client_id?: number;
  active?: boolean;
}

export interface FreshBooksService {
  id: number;
  business_id?: number;
  name?: string;
  billable?: boolean;
  vis_state?: number;
}

export interface FreshBooksTeamMember {
  identity_id?: number;
  uuid?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  active?: boolean;
  business_role_name?: string;
}

export interface FreshBooksBusiness {
  id: number;
  account_id: string;
  name?: string;
  active?: boolean;
}

export interface FreshBooksBusinessMembership {
  id?: number;
  role?: string;
  business?: FreshBooksBusiness;
}

export interface FreshBooksMeResponse {
  response?: {
    id?: number;
    business_memberships?: FreshBooksBusinessMembership[];
  };
}

export interface FreshBooksMeta {
  page?: number;
  pages?: number;
  per_page?: number;
  total?: number;
}

// Time Tracking / Projects / Services list endpoints return the collection
// under a resource key at the top level.
export interface FreshBooksTimeEntriesResponse {
  time_entries?: FreshBooksTimeEntry[];
  meta?: FreshBooksMeta;
}

export interface FreshBooksTimeEntryResponse {
  time_entry?: FreshBooksTimeEntry;
}

export interface FreshBooksProjectsResponse {
  projects?: FreshBooksProject[];
  meta?: FreshBooksMeta;
}

export interface FreshBooksProjectResponse {
  project?: FreshBooksProject;
}

export interface FreshBooksServicesResponse {
  services?: FreshBooksService[];
  meta?: FreshBooksMeta;
}

// The Identity/Auth API wraps its payloads under `response`.
export interface FreshBooksTeamMembersResponse {
  response?: FreshBooksTeamMember[];
  meta?: FreshBooksMeta;
}

// The Events (accounting-style) API double-wraps under `response.result`.
export interface FreshBooksCallback {
  callbackid?: number;
  event?: string;
  uri?: string;
  verified?: boolean;
  verifier?: string;
}

export interface FreshBooksCallbackResponse {
  response?: { result?: { callback?: FreshBooksCallback } };
}

export interface FreshBooksCallbacksResponse {
  response?: { result?: { callbacks?: FreshBooksCallback[] } };
}

// Inbound webhook body (FreshBooks posts form-encoded parameters). `verifier`
// is present only on the one-time verification handshake; `name` carries the
// event, e.g. "time_entry.update".
export interface FreshBooksWebhookPayload {
  name?: string;
  object_id?: string | number;
  account_id?: string;
  business_id?: string | number;
  identity_id?: string | number;
  verifier?: string;
  verified?: string | boolean;
  system?: string;
  user_id?: string | number;
}

export interface SyncInput {
  event?: string;
  triggerId?: string;
  taskId?: string;
  entityId?: string;
  item?: Partial<TaskDto> & {
    taskId?: string;
    id?: string;
    projectId?: string;
    userId?: string;
    rateId?: string;
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
