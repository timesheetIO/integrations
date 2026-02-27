import { ExternalEntity } from '@timesheet/integration-sdk';
import {
  QuickBooksCreateOrUpdateResponse,
  QuickBooksCustomer,
  QuickBooksEmployee,
  QuickBooksQueryResponse,
  QuickBooksTimeActivity
} from './types';

interface QuickBooksClientOptions {
  realmId: string;
  sandboxMode: boolean;
  getAccessToken: () => Promise<string>;
  refreshAccessToken: () => Promise<string>;
}

export class QuickBooksClient {
  private readonly realmId: string;
  private readonly sandboxMode: boolean;
  private readonly getAccessToken: () => Promise<string>;
  private readonly refreshAccessToken: () => Promise<string>;

  constructor(options: QuickBooksClientOptions) {
    this.realmId = options.realmId;
    this.sandboxMode = options.sandboxMode;
    this.getAccessToken = options.getAccessToken;
    this.refreshAccessToken = options.refreshAccessToken;
  }

  async testConnection(): Promise<boolean> {
    const response = await this.query('select * from companyinfo');
    const companyInfo = asArray<Record<string, unknown>>(response.QueryResponse?.CompanyInfo);
    return companyInfo.length > 0;
  }

  async listCustomers(): Promise<ExternalEntity[]> {
    const response = await this.query('select * from customer MAXRESULTS 1000');
    const customers = asArray<QuickBooksCustomer>(response.QueryResponse?.Customer);
    return customers.map((customer) => ({
      id: customer.Id,
      name: customer.DisplayName ?? customer.CompanyName ?? customer.Id,
      active: customer.Active ?? true
    }));
  }

  async listEmployees(): Promise<ExternalEntity[]> {
    const response = await this.query('select * from employee MAXRESULTS 1000');
    const employees = asArray<QuickBooksEmployee>(response.QueryResponse?.Employee);
    return employees.map((employee) => ({
      id: employee.Id,
      name: employee.DisplayName
        ?? ([employee.GivenName, employee.FamilyName].filter(Boolean).join(' ').trim() || employee.Id),
      active: employee.Active ?? true
    }));
  }

  async listTimeActivities(): Promise<QuickBooksTimeActivity[]> {
    const response = await this.query('select * from timeactivity MAXRESULTS 1000');
    return asArray<QuickBooksTimeActivity>(response.QueryResponse?.TimeActivity);
  }

  async getTimeActivity(id: string): Promise<QuickBooksTimeActivity | null> {
    const escapedId = id.replace(/'/g, "''");
    const response = await this.query(`select * from timeactivity where id = '${escapedId}'`);
    const entries = asArray<QuickBooksTimeActivity>(response.QueryResponse?.TimeActivity);
    return entries.length > 0 ? entries[0] : null;
  }

  async createTimeActivity(payload: Record<string, unknown>): Promise<QuickBooksTimeActivity> {
    const response = await this.request<QuickBooksCreateOrUpdateResponse>('POST', '/timeactivity', payload);
    if (!response?.TimeActivity?.Id) {
      throw new Error('QuickBooks createTimeActivity did not return a time activity id.');
    }
    return response.TimeActivity;
  }

  async updateTimeActivity(payload: Record<string, unknown>): Promise<QuickBooksTimeActivity> {
    const response = await this.request<QuickBooksCreateOrUpdateResponse>('POST', '/timeactivity', payload);
    if (!response?.TimeActivity?.Id) {
      throw new Error('QuickBooks updateTimeActivity did not return a time activity id.');
    }
    return response.TimeActivity;
  }

  async deleteTimeActivity(id: string, syncToken: string): Promise<void> {
    await this.request<QuickBooksCreateOrUpdateResponse>(
      'POST',
      '/timeactivity?operation=delete',
      {
        Id: id,
        SyncToken: syncToken,
        sparse: true
      }
    );
  }

  private async query(query: string): Promise<QuickBooksQueryResponse> {
    const path = `/query?query=${encodeURIComponent(query)}`;
    return this.request<QuickBooksQueryResponse>('GET', path);
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    retried = false
  ): Promise<T> {
    const token = await this.getAccessToken();
    const response = await fetch(`${this.baseUrl()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });

    if (response.status === 401 && !retried) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed) {
        return this.request<T>(method, path, body, true);
      }
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`QuickBooks API ${method} ${path} failed (${response.status}): ${errorBody}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private baseUrl(): string {
    const endpoint = this.sandboxMode
      ? 'https://sandbox-quickbooks.api.intuit.com/v3/company'
      : 'https://quickbooks.api.intuit.com/v3/company';
    return `${endpoint}/${encodeURIComponent(this.realmId)}`;
  }
}

export function asArray<T>(value: T[] | T | undefined | null): T[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}
