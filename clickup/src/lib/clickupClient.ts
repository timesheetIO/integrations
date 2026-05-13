import { ExternalEntity } from '@timesheet/integration-sdk';
import {
  ClickUpFoldersResponse,
  ClickUpList,
  ClickUpListsResponse,
  ClickUpSpacesResponse,
  ClickUpTask,
  ClickUpTasksResponse,
  ClickUpTeam,
  ClickUpTeamsResponse,
  ClickUpTimeEntry,
  ClickUpTimeEntryEnvelope
} from './types';

interface ClickUpClientOptions {
  getAccessToken: () => Promise<string>;
  refreshAccessToken: () => Promise<string>;
}

export class ClickUpClient {
  private static readonly BASE_URL = 'https://api.clickup.com/api/v2';
  private static readonly REQUEST_TIMEOUT_MS = 30_000;

  private readonly fetchAccessToken: () => Promise<string>;
  private readonly fetchRefreshedToken: () => Promise<string>;
  private cachedToken: string | null = null;

  constructor(options: ClickUpClientOptions) {
    this.fetchAccessToken = options.getAccessToken;
    this.fetchRefreshedToken = options.refreshAccessToken;
  }

  async testConnection(): Promise<boolean> {
    const teams = await this.listTeams();
    return teams.length > 0;
  }

  async listTeams(): Promise<ClickUpTeam[]> {
    const response = await this.request<ClickUpTeamsResponse>('GET', '/team');
    return response.teams ?? [];
  }

  /**
   * Aggregates members across every workspace the user belongs to, deduplicated
   * by ClickUp user id. The `id` field is the raw ClickUp user id so callers
   * can pass it straight back as a time-entry `assignee`.
   */
  async listAllMembers(): Promise<ExternalEntity[]> {
    const teams = await this.listTeams();
    const seen = new Set<string>();
    const result: ExternalEntity[] = [];
    for (const team of teams) {
      for (const member of team.members ?? []) {
        const user = member.user;
        if (!user?.id) {
          continue;
        }
        const id = String(user.id);
        if (seen.has(id)) {
          continue;
        }
        seen.add(id);
        const display = user.username || user.email || id;
        result.push({
          id,
          name: user.email ? `${display} (${user.email})` : display,
          username: user.username ?? null,
          email: user.email ?? null,
          teamId: team.id,
          teamName: team.name
        });
      }
    }
    return result;
  }

  async listSpaces(teamId: string): Promise<Array<{ id: string; name: string }>> {
    const response = await this.request<ClickUpSpacesResponse>(
      'GET',
      `/team/${encodeURIComponent(teamId)}/space?archived=false`
    );
    return response.spaces ?? [];
  }

  async listFolders(spaceId: string): Promise<Array<{ id: string; name: string }>> {
    const response = await this.request<ClickUpFoldersResponse>(
      'GET',
      `/space/${encodeURIComponent(spaceId)}/folder?archived=false`
    );
    return response.folders ?? [];
  }

  async listFolderlessLists(spaceId: string): Promise<ClickUpList[]> {
    const response = await this.request<ClickUpListsResponse>(
      'GET',
      `/space/${encodeURIComponent(spaceId)}/list?archived=false`
    );
    return response.lists ?? [];
  }

  async listFolderLists(folderId: string): Promise<ClickUpList[]> {
    const response = await this.request<ClickUpListsResponse>(
      'GET',
      `/folder/${encodeURIComponent(folderId)}/list?archived=false`
    );
    return response.lists ?? [];
  }

  /**
   * Returns every list across every space/folder in the user's accessible
   * workspaces, flattened into ExternalEntity objects. Each id is encoded as
   * `team_id:list_id` so subsequent sync operations don't have to re-resolve
   * the workspace.
   */
  async listAllLists(): Promise<ExternalEntity[]> {
    const result: ExternalEntity[] = [];
    const teams = await this.listTeams();

    for (const team of teams) {
      const spaces = await this.listSpaces(team.id);
      for (const space of spaces) {
        const folderless = await this.listFolderlessLists(space.id);
        for (const list of folderless) {
          result.push(toListEntity(team, space.name, undefined, list));
        }

        const folders = await this.listFolders(space.id);
        for (const folder of folders) {
          const folderLists = await this.listFolderLists(folder.id);
          for (const list of folderLists) {
            result.push(toListEntity(team, space.name, folder.name, list));
          }
        }
      }
    }

    return result;
  }

  async listTasksForList(listId: string, options?: { dateUpdatedGt?: number }): Promise<ClickUpTask[]> {
    const collected: ClickUpTask[] = [];
    let page = 0;
    while (true) {
      const params = new URLSearchParams({
        archived: 'false',
        subtasks: 'true',
        include_closed: 'true',
        page: String(page)
      });
      if (options?.dateUpdatedGt) {
        params.set('date_updated_gt', String(options.dateUpdatedGt));
      }
      const response = await this.request<ClickUpTasksResponse>(
        'GET',
        `/list/${encodeURIComponent(listId)}/task?${params.toString()}`
      );
      const tasks = response.tasks ?? [];
      collected.push(...tasks);
      if (tasks.length === 0 || response.last_page) {
        break;
      }
      page += 1;
    }
    return collected;
  }

  async getTask(taskId: string): Promise<ClickUpTask | null> {
    try {
      return await this.request<ClickUpTask>('GET', `/task/${encodeURIComponent(taskId)}`);
    } catch (error) {
      if (String(error).includes('(404)')) {
        return null;
      }
      throw error;
    }
  }

  async createTask(listId: string, payload: Record<string, unknown>): Promise<ClickUpTask> {
    return this.request<ClickUpTask>(
      'POST',
      `/list/${encodeURIComponent(listId)}/task`,
      payload
    );
  }

  async updateTask(taskId: string, payload: Record<string, unknown>): Promise<ClickUpTask> {
    return this.request<ClickUpTask>(
      'PUT',
      `/task/${encodeURIComponent(taskId)}`,
      payload
    );
  }

  async deleteTask(taskId: string): Promise<void> {
    try {
      await this.request<void>('DELETE', `/task/${encodeURIComponent(taskId)}`);
    } catch (error) {
      if (String(error).includes('(404)')) {
        return;
      }
      throw error;
    }
  }

  async createTimeEntry(teamId: string, payload: Record<string, unknown>): Promise<ClickUpTimeEntry> {
    const envelope = await this.request<ClickUpTimeEntryEnvelope>(
      'POST',
      `/team/${encodeURIComponent(teamId)}/time_entries`,
      payload
    );
    return unwrapTimeEntry(envelope);
  }

  async updateTimeEntry(teamId: string, timerId: string, payload: Record<string, unknown>): Promise<ClickUpTimeEntry> {
    const envelope = await this.request<ClickUpTimeEntryEnvelope>(
      'PUT',
      `/team/${encodeURIComponent(teamId)}/time_entries/${encodeURIComponent(timerId)}`,
      payload
    );
    return unwrapTimeEntry(envelope);
  }

  async deleteTimeEntry(teamId: string, timerId: string): Promise<void> {
    try {
      await this.request<void>(
        'DELETE',
        `/team/${encodeURIComponent(teamId)}/time_entries/${encodeURIComponent(timerId)}`
      );
    } catch (error) {
      if (String(error).includes('(404)')) {
        return;
      }
      throw error;
    }
  }

  async getTimeEntry(teamId: string, timerId: string): Promise<ClickUpTimeEntry | null> {
    try {
      const envelope = await this.request<ClickUpTimeEntryEnvelope>(
        'GET',
        `/team/${encodeURIComponent(teamId)}/time_entries/${encodeURIComponent(timerId)}`
      );
      return unwrapTimeEntry(envelope);
    } catch (error) {
      if (String(error).includes('(404)')) {
        return null;
      }
      throw error;
    }
  }

  async listTimeEntries(
    teamId: string,
    options?: { startMs?: number; endMs?: number; taskId?: string }
  ): Promise<ClickUpTimeEntry[]> {
    const params = new URLSearchParams();
    if (options?.startMs) {
      params.set('start_date', String(options.startMs));
    }
    if (options?.endMs) {
      params.set('end_date', String(options.endMs));
    }
    if (options?.taskId) {
      params.set('task_id', options.taskId);
    }
    const qs = params.toString();
    const envelope = await this.request<ClickUpTimeEntryEnvelope>(
      'GET',
      `/team/${encodeURIComponent(teamId)}/time_entries${qs ? `?${qs}` : ''}`
    );
    const data = envelope?.data;
    if (!data) {
      return [];
    }
    return Array.isArray(data) ? data : [data];
  }

  async createWebhook(
    teamId: string,
    endpoint: string,
    events: string[]
  ): Promise<{ id: string; webhook?: { id?: string; secret?: string } }> {
    return this.request<{ id: string; webhook?: { id?: string; secret?: string } }>(
      'POST',
      `/team/${encodeURIComponent(teamId)}/webhook`,
      { endpoint, events }
    );
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    try {
      await this.request<void>('DELETE', `/webhook/${encodeURIComponent(webhookId)}`);
    } catch (error) {
      if (String(error).includes('(404)')) {
        return;
      }
      throw error;
    }
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
    body?: unknown,
    retried = false
  ): Promise<T> {
    const token = await this.getAccessToken();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ClickUpClient.REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${ClickUpClient.BASE_URL}${path}`, {
        method,
        headers: {
          // ClickUp expects the raw token in the Authorization header, not a Bearer prefix.
          Authorization: token,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(`ClickUp API ${method} ${path} timed out after ${ClickUpClient.REQUEST_TIMEOUT_MS}ms`);
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
      throw new Error(`ClickUp API ${method} ${path} failed (${response.status}): ${errorBody}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    if (!text) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }
}

function unwrapTimeEntry(envelope: ClickUpTimeEntryEnvelope): ClickUpTimeEntry {
  const data = envelope?.data;
  if (!data) {
    throw new Error('ClickUp time entry response missing data');
  }
  const entry = Array.isArray(data) ? data[0] : data;
  if (!entry?.id) {
    throw new Error('ClickUp time entry response missing id');
  }
  return entry;
}

function toListEntity(
  team: ClickUpTeam,
  spaceName: string,
  folderName: string | undefined,
  list: ClickUpList
): ExternalEntity {
  const path = [team.name, spaceName, folderName, list.name].filter(Boolean).join(' / ');
  return {
    // Encode the workspace alongside the list so we don't have to re-resolve it
    // on every sync. The mapping store keeps the externalId opaque.
    id: `${team.id}:${list.id}`,
    name: path,
    listId: list.id,
    teamId: team.id,
    listName: list.name,
    spaceName,
    folderName: folderName ?? null,
    teamName: team.name
  };
}
