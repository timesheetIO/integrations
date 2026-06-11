import { TaskDto } from '@timesheet/integration-sdk';

export interface QuickBooksConfig {
  syncDirection?: 'bidirectional' | 'timesheet-to-qb' | 'qb-to-timesheet' | 'timesheet-to-external' | 'external-to-timesheet';
  rateSource?: 'quickbooks-service' | 'timesheet-rate';
  webhookVerifierToken?: string;
}

export interface QuickBooksRef {
  value?: string;
  name?: string;
}

export interface QuickBooksMetaData {
  CreateTime?: string;
  LastUpdatedTime?: string;
  LastChangedInQB?: string;
}

export interface QuickBooksTimeActivity {
  Id: string;
  SyncToken?: string;
  TxnDate?: string;
  StartTime?: string;
  EndTime?: string;
  Hours?: number;
  Minutes?: number;
  Description?: string;
  BillableStatus?: string;
  HourlyRate?: number;
  CustomerRef?: QuickBooksRef;
  EmployeeRef?: QuickBooksRef;
  ItemRef?: QuickBooksRef;
  MetaData?: QuickBooksMetaData;
}

export interface QuickBooksCustomer {
  Id: string;
  DisplayName?: string;
  CompanyName?: string;
  Active?: boolean;
}

export interface QuickBooksEmployee {
  Id: string;
  DisplayName?: string;
  GivenName?: string;
  FamilyName?: string;
  Active?: boolean;
}

export interface QuickBooksItem {
  Id: string;
  Name?: string;
  FullyQualifiedName?: string;
  Type?: string;
  Active?: boolean;
  UnitPrice?: number;
}

export interface QuickBooksQueryResponse {
  QueryResponse?: {
    Customer?: QuickBooksCustomer[];
    Employee?: QuickBooksEmployee[];
    Item?: QuickBooksItem[];
    TimeActivity?: QuickBooksTimeActivity[];
    CompanyInfo?: Array<Record<string, unknown>>;
    startPosition?: number;
    maxResults?: number;
    totalCount?: number;
  };
}

export interface QuickBooksCreateOrUpdateResponse {
  TimeActivity?: QuickBooksTimeActivity;
}

// Intuit webhooks use the CloudEvents format: the payload is a top-level array of
// events, one per changed entity. `type` is "qbo.<entity>.<action>.v1"
// (e.g. "qbo.timeactivity.updated.v1"), `intuitaccountid` carries the realmId and
// `intuitentityid` the entity id.
export interface QuickBooksCloudEvent {
  specversion?: string;
  id?: string;
  source?: string;
  type?: string;
  time?: string;
  intuitentityid?: string;
  intuitaccountid?: string;
  data?: unknown;
}

export type QuickBooksWebhookPayload = QuickBooksCloudEvent[];

export interface SyncInput {
  event?: string;
  triggerId?: string;
  taskId?: string;
  item?: Partial<TaskDto> & { taskId?: string; id?: string; projectId?: string; userId?: string };
  externalTaskId?: string;
  realmId?: string;
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
  /** Set by the backend on app-level webhooks it has already verified and routed by realm. */
  verified?: boolean;
}
