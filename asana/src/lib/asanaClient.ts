import { ExternalEntity } from '@timesheet/integration-sdk';
import {
  AsanaPagedResponse,
  AsanaProject,
  AsanaSingleResponse,
  AsanaTask,
  AsanaTimeTrackingEntry,
  AsanaUser,
  AsanaWorkspace
} from './types';

interface AsanaClientOptions {
  getAccessToken: () => Promise<string>;
  refreshAccessToken: () => Promise<string>;
  workspaceId?: string;
}

export class AsanaClient {
  private static readonly BASE_URL = 'https://app.asana.com/api/1.0';
  private static readonly REQUEST_TIMEOUT_MS = 30_000;
  private static readonly PAGE_LIMIT = 100;

  private readonly fetchAccessToken: () => Promise<string>;
  private readonly fetchRefreshedToken: () => Promise<string>;
  private cachedToken: string | null = null;
  private readonly workspaceId: string | undefined;

  constructor(options: AsanaClientOptions) {
    this.fetchAccessToken = options.getAccessToken;
    this.fetchRefreshedToken = options.refreshAccessToken;
    this.workspaceId = options.workspaceId;
  }

  async testConnection(): Promise<boolean> {
    const me = await this.request<AsanaSingleResponse<{ gid: string }>>('GET', '/users/me');
    return !!me?.data?.gid;
  }

  async listWorkspaces(): Promise<ExternalEntity[]> {
    const workspaces = await this.paginate<AsanaWorkspace>('/workspaces', {
      opt_fields: 'name'
    });
    return workspaces.map((ws) => ({
      id: ws.gid,
      name: ws.name ?? ws.gid
    }));
  }

  /**
   * Members of the configured workspaces. Asana scopes users to a workspace, so
   * without one configured this unions the workspaces the token can see.
   */
  async listUsers(): Promise<ExternalEntity[]> {
    const workspaceIds = this.workspaceId
      ? [this.workspaceId]
      : (await this.listWorkspaces()).map((ws) => ws.id);

    const byId = new Map<string, ExternalEntity>();
    for (const wsId of workspaceIds) {
      const users = await this.paginate<AsanaUser>('/users', {
        workspace: wsId,
        opt_fields: 'name,email'
      });
      for (const user of users) {
        if (!user.gid || byId.has(user.gid)) continue;
        byId.set(user.gid, {
          id: user.gid,
          name: user.name ?? user.email ?? user.gid,
          email: user.email ?? ''
        });
      }
    }
    return Array.from(byId.values());
  }

  async listProjects(): Promise<ExternalEntity[]> {
    // If a workspace is configured, scope projects to it; otherwise list
    // projects across all workspaces the token can see.
    const workspaceIds = this.workspaceId
      ? [this.workspaceId]
      : (await this.listWorkspaces()).map((ws) => ws.id);

    const out: ExternalEntity[] = [];
    for (const wsId of workspaceIds) {
      const projects = await this.paginate<AsanaProject>('/projects', {
        workspace: wsId,
        archived: 'false',
        opt_fields: 'name,archived,workspace.name'
      });
      for (const project of projects) {
        if (!project.gid) continue;
        const workspaceName = project.workspace?.name;
        out.push({
          id: project.gid,
          name: workspaceName ? `${workspaceName} / ${project.name ?? project.gid}` : project.name ?? project.gid,
          workspaceId: project.workspace?.gid ?? wsId,
          archived: project.archived ?? false
        });
      }
    }
    return out;
  }

  async listTasksInProject(projectId: string, modifiedSinceIso?: string): Promise<AsanaTask[]> {
    const query: Record<string, string> = {
      opt_fields: 'name,notes,completed,completed_at,created_at,modified_at,due_at,due_on,start_at,start_on,assignee.gid,projects.gid,workspace.gid'
    };
    if (modifiedSinceIso) {
      query.modified_since = modifiedSinceIso;
    }
    return this.paginate<AsanaTask>(`/projects/${encodeURIComponent(projectId)}/tasks`, query);
  }

  async getTask(taskId: string): Promise<AsanaTask | null> {
    try {
      const response = await this.request<AsanaSingleResponse<AsanaTask>>(
        'GET',
        `/tasks/${encodeURIComponent(taskId)}`,
        {
          opt_fields: 'name,notes,completed,completed_at,created_at,modified_at,due_at,due_on,start_at,start_on,assignee.gid,projects.gid,workspace.gid'
        }
      );
      return response?.data ?? null;
    } catch (err) {
      if (String(err).includes('(404)')) {
        return null;
      }
      throw err;
    }
  }

  async createTask(payload: Record<string, unknown>): Promise<AsanaTask> {
    const response = await this.request<AsanaSingleResponse<AsanaTask>>(
      'POST',
      '/tasks',
      undefined,
      { data: payload }
    );
    if (!response?.data?.gid) {
      throw new Error('Asana createTask did not return a task gid.');
    }
    return response.data;
  }

  async updateTask(taskId: string, payload: Record<string, unknown>): Promise<AsanaTask> {
    const response = await this.request<AsanaSingleResponse<AsanaTask>>(
      'PUT',
      `/tasks/${encodeURIComponent(taskId)}`,
      undefined,
      { data: payload }
    );
    if (!response?.data?.gid) {
      throw new Error('Asana updateTask did not return a task gid.');
    }
    return response.data;
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.request<unknown>('DELETE', `/tasks/${encodeURIComponent(taskId)}`);
  }

  async listTimeTrackingEntries(taskId: string): Promise<AsanaTimeTrackingEntry[]> {
    return this.paginate<AsanaTimeTrackingEntry>(
      `/tasks/${encodeURIComponent(taskId)}/time_tracking_entries`,
      { opt_fields: 'duration_minutes,entered_on,created_at,created_by.gid,task.gid' }
    );
  }

  async getTimeTrackingEntry(entryId: string): Promise<AsanaTimeTrackingEntry | null> {
    try {
      const response = await this.request<AsanaSingleResponse<AsanaTimeTrackingEntry>>(
        'GET',
        `/time_tracking_entries/${encodeURIComponent(entryId)}`,
        { opt_fields: 'duration_minutes,entered_on,created_at,created_by.gid,task.gid' }
      );
      return response?.data ?? null;
    } catch (err) {
      if (String(err).includes('(404)')) {
        return null;
      }
      throw err;
    }
  }

  async createTimeTrackingEntry(
    taskId: string,
    payload: { duration_minutes: number; entered_on: string }
  ): Promise<AsanaTimeTrackingEntry> {
    const response = await this.request<AsanaSingleResponse<AsanaTimeTrackingEntry>>(
      'POST',
      `/tasks/${encodeURIComponent(taskId)}/time_tracking_entries`,
      undefined,
      { data: payload }
    );
    if (!response?.data?.gid) {
      throw new Error('Asana createTimeTrackingEntry did not return a gid.');
    }
    return response.data;
  }

  async updateTimeTrackingEntry(
    entryId: string,
    payload: Partial<{ duration_minutes: number; entered_on: string }>
  ): Promise<AsanaTimeTrackingEntry> {
    const response = await this.request<AsanaSingleResponse<AsanaTimeTrackingEntry>>(
      'PUT',
      `/time_tracking_entries/${encodeURIComponent(entryId)}`,
      undefined,
      { data: payload }
    );
    if (!response?.data?.gid) {
      throw new Error('Asana updateTimeTrackingEntry did not return a gid.');
    }
    return response.data;
  }

  async deleteTimeTrackingEntry(entryId: string): Promise<void> {
    await this.request<unknown>('DELETE', `/time_tracking_entries/${encodeURIComponent(entryId)}`);
  }

  async createWebhook(resourceId: string, targetUrl: string): Promise<{ gid: string }> {
    const response = await this.request<AsanaSingleResponse<{ gid: string }>>(
      'POST',
      '/webhooks',
      undefined,
      {
        data: {
          resource: resourceId,
          target: targetUrl
        }
      }
    );
    if (!response?.data?.gid) {
      throw new Error('Asana createWebhook did not return a webhook gid.');
    }
    return response.data;
  }

  async deleteWebhook(webhookGid: string): Promise<void> {
    try {
      await this.request<unknown>('DELETE', `/webhooks/${encodeURIComponent(webhookGid)}`);
    } catch (err) {
      // 404 means the hook was already cleaned up — not an error.
      if (!String(err).includes('(404)')) {
        throw err;
      }
    }
  }

  private async paginate<T>(path: string, baseQuery: Record<string, string>): Promise<T[]> {
    const out: T[] = [];
    let offset: string | undefined;
    do {
      const query: Record<string, string> = { ...baseQuery, limit: String(AsanaClient.PAGE_LIMIT) };
      if (offset) {
        query.offset = offset;
      }
      const response = await this.request<AsanaPagedResponse<T>>('GET', path, query);
      if (response?.data?.length) {
        out.push(...response.data);
      }
      offset = response?.next_page?.offset ?? undefined;
    } while (offset);
    return out;
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

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    query?: Record<string, string>,
    body?: unknown,
    retried = false
  ): Promise<T> {
    const token = await this.getAccessToken();
    const url = this.buildUrl(path, query);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), AsanaClient.REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
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
        throw new Error(`Asana API ${method} ${path} timed out after ${AsanaClient.REQUEST_TIMEOUT_MS}ms`);
      }
      throw error;
    }
    clearTimeout(timeoutId);

    if (response.status === 401 && !retried) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed) {
        return this.request<T>(method, path, query, body, true);
      }
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Asana API ${method} ${path} failed (${response.status}): ${errorBody}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private buildUrl(path: string, query?: Record<string, string>): string {
    const url = new URL(`${AsanaClient.BASE_URL}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') {
          continue;
        }
        url.searchParams.append(key, String(value));
      }
    }
    return url.toString();
  }
}
