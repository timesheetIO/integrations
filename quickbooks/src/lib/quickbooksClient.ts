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
  sandbox?: boolean;
  getAccessToken: () => Promise<string>;
  refreshAccessToken: () => Promise<string>;
}

export class QuickBooksClient {
  private static readonly REQUEST_TIMEOUT_MS = 30_000;
  private static readonly PAGE_SIZE = 1000;

  private readonly realmId: string;
  private readonly sandbox: boolean;
  private cachedToken: string | null = null;
  private readonly fetchAccessToken: () => Promise<string>;
  private readonly fetchRefreshedToken: () => Promise<string>;

  constructor(options: QuickBooksClientOptions) {
    this.realmId = options.realmId;
    this.sandbox = options.sandbox === true;
    this.fetchAccessToken = options.getAccessToken;
    this.fetchRefreshedToken = options.refreshAccessToken;
  }

  async testConnection(): Promise<boolean> {
    const response = await this.query('select * from companyinfo');
    const companyInfo = asArray<Record<string, unknown>>(response.QueryResponse?.CompanyInfo);
    return companyInfo.length > 0;
  }

  async listCustomers(): Promise<ExternalEntity[]> {
    const customers = await this.queryAll<QuickBooksCustomer>('Customer', 'select * from customer');
    return customers.map((customer) => ({
      id: customer.Id,
      name: customer.DisplayName ?? customer.CompanyName ?? customer.Id,
      active: customer.Active ?? true
    }));
  }

  async listEmployees(): Promise<ExternalEntity[]> {
    const employees = await this.queryAll<QuickBooksEmployee>('Employee', 'select * from employee');
    return employees.map((employee) => ({
      id: employee.Id,
      name: employee.DisplayName
        ?? ([employee.GivenName, employee.FamilyName].filter(Boolean).join(' ').trim() || employee.Id),
      active: employee.Active ?? true
    }));
  }

  async listTimeActivities(options?: { sinceIso?: string }): Promise<QuickBooksTimeActivity[]> {
    let baseQuery = 'select * from timeactivity';
    if (options?.sinceIso) {
      const escaped = options.sinceIso.replace(/'/g, "''");
      baseQuery += ` where MetaData.LastUpdatedTime >= '${escaped}'`;
    }
    return this.queryAll<QuickBooksTimeActivity>('TimeActivity', baseQuery);
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

  private async getAccessToken(): Promise<string> {
    if (this.cachedToken) {
      return this.cachedToken;
    }
    this.cachedToken = await this.fetchAccessToken();
    return this.cachedToken;
  }

  private async refreshAccessToken(): Promise<string> {
    this.cachedToken = null;
    this.cachedToken = await this.fetchRefreshedToken();
    return this.cachedToken;
  }

  private async query(queryString: string): Promise<QuickBooksQueryResponse> {
    const path = `/query?query=${encodeURIComponent(queryString)}`;
    return this.request<QuickBooksQueryResponse>('GET', path);
  }

  private async queryAll<T>(entityName: string, baseQuery: string): Promise<T[]> {
    const all: T[] = [];
    let position = 1;
    while (true) {
      const pageQuery = `${baseQuery} STARTPOSITION ${position} MAXRESULTS ${QuickBooksClient.PAGE_SIZE}`;
      const response = await this.query(pageQuery);
      const queryResponse = response.QueryResponse as Record<string, unknown> | undefined;
      const items = asArray<T>(queryResponse?.[entityName] as T | T[] | undefined | null);
      all.push(...items);
      if (items.length < QuickBooksClient.PAGE_SIZE) {
        break;
      }
      position += items.length;
    }
    return all;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    retried = false
  ): Promise<T> {
    const token = await this.getAccessToken();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), QuickBooksClient.REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl()}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(`QuickBooks API ${method} ${path} timed out after ${QuickBooksClient.REQUEST_TIMEOUT_MS}ms`);
      }
      throw error;
    }
    clearTimeout(timeoutId);

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
    const host = this.sandbox
      ? 'https://sandbox-quickbooks.api.intuit.com/v3/company'
      : 'https://quickbooks.api.intuit.com/v3/company';
    return `${host}/${encodeURIComponent(this.realmId)}`;
  }
}

export function asArray<T>(value: T[] | T | undefined | null): T[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}
