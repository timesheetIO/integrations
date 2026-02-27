import { TaskDto } from '@timesheet/integration-sdk';

export interface QuickBooksConfig {
  syncDirection?: 'bidirectional' | 'timesheet-to-qb' | 'qb-to-timesheet' | 'timesheet-to-external' | 'external-to-timesheet';
  sandboxMode?: boolean;
  realmId?: string;
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
  CustomerRef?: QuickBooksRef;
  EmployeeRef?: QuickBooksRef;
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

export interface QuickBooksQueryResponse {
  QueryResponse?: {
    Customer?: QuickBooksCustomer[];
    Employee?: QuickBooksEmployee[];
    TimeActivity?: QuickBooksTimeActivity[];
    CompanyInfo?: Array<Record<string, unknown>>;
  };
}

export interface QuickBooksCreateOrUpdateResponse {
  TimeActivity?: QuickBooksTimeActivity;
}

export interface QuickBooksWebhookEntity {
  name?: string;
  id?: string;
  operation?: string;
}

export interface QuickBooksWebhookNotification {
  realmId?: string;
  dataChangeEvent?: {
    entities?: QuickBooksWebhookEntity[];
  };
}

export interface QuickBooksWebhookPayload {
  eventNotifications?: QuickBooksWebhookNotification[];
}

export interface SyncInput {
  event?: string;
  triggerId?: string;
  taskId?: string;
  item?: Partial<TaskDto> & { taskId?: string; id?: string };
  externalTaskId?: string;
  realmId?: string;
  body?: unknown;
}
