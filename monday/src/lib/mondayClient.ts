import { ExternalEntity } from '@timesheet/integration-sdk';
import {
  MondayBoard,
  MondayBoardItemsResponse,
  MondayColumn,
  MondayItem,
  MondayNextItemsResponse,
  MondayUser
} from './types';

interface MondayClientOptions {
  getAccessToken: () => Promise<string>;
  refreshAccessToken: () => Promise<string>;
}

interface GraphQLError {
  message: string;
  status?: number;
  extensions?: { code?: string };
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLError[];
  error_code?: string;
  error_message?: string;
}

const ITEMS_PAGE_LIMIT = 100;

export class MondayClient {
  private static readonly API_URL = 'https://api.monday.com/v2';
  private static readonly API_VERSION = '2024-10';
  private static readonly REQUEST_TIMEOUT_MS = 30_000;

  private readonly fetchAccessToken: () => Promise<string>;
  private readonly fetchRefreshedToken: () => Promise<string>;
  private cachedToken: string | null = null;

  constructor(options: MondayClientOptions) {
    this.fetchAccessToken = options.getAccessToken;
    this.fetchRefreshedToken = options.refreshAccessToken;
  }

  async testConnection(): Promise<boolean> {
    const data = await this.graphql<{ me?: { id?: string } }>(
      'query { me { id } }'
    );
    return Boolean(data?.me?.id);
  }

  async listBoards(): Promise<MondayBoard[]> {
    const collected: MondayBoard[] = [];
    let page = 1;
    while (true) {
      const data = await this.graphql<{ boards?: MondayBoard[] }>(
        `query ($limit: Int!, $page: Int!) {
          boards(limit: $limit, page: $page, state: active, order_by: created_at) {
            id
            name
            state
            workspace { id name }
          }
        }`,
        { limit: ITEMS_PAGE_LIMIT, page }
      );
      const boards = data?.boards ?? [];
      if (boards.length === 0) {
        break;
      }
      collected.push(...boards);
      if (boards.length < ITEMS_PAGE_LIMIT) {
        break;
      }
      page += 1;
    }
    return collected;
  }

  async listAllBoardsAsEntities(): Promise<ExternalEntity[]> {
    const boards = await this.listBoards();
    return boards.map(toBoardEntity);
  }

  async listUsers(): Promise<MondayUser[]> {
    const collected: MondayUser[] = [];
    let page = 1;
    while (true) {
      const data = await this.graphql<{ users?: MondayUser[] }>(
        `query ($limit: Int!, $page: Int!) {
          users(limit: $limit, page: $page, newest_first: false) {
            id
            name
            email
            enabled
            is_guest
          }
        }`,
        { limit: ITEMS_PAGE_LIMIT, page }
      );
      const users = data?.users ?? [];
      if (users.length === 0) {
        break;
      }
      collected.push(...users);
      if (users.length < ITEMS_PAGE_LIMIT) {
        break;
      }
      page += 1;
    }
    return collected;
  }

  async listUsersAsEntities(): Promise<ExternalEntity[]> {
    const users = await this.listUsers();
    return users
      .filter((user) => user.id && user.enabled !== false)
      .map(toUserEntity);
  }

  async listItemsForBoard(boardId: string, options?: { updatedSinceMs?: number }): Promise<MondayItem[]> {
    const collected: MondayItem[] = [];
    const initial = await this.graphql<MondayBoardItemsResponse>(
      `query ($boardIds: [ID!], $limit: Int!) {
        boards(ids: $boardIds) {
          items_page(limit: $limit) {
            cursor
            items {
              id
              name
              state
              creator_id
              created_at
              updated_at
              board { id name }
              parent_item { id board { id } }
              column_values {
                id
                type
                value
                text
              }
            }
          }
        }
      }`,
      { boardIds: [boardId], limit: ITEMS_PAGE_LIMIT }
    );

    const firstPage = initial?.boards?.[0]?.items_page;
    if (firstPage?.items?.length) {
      collected.push(...firstPage.items);
    }

    let cursor = firstPage?.cursor ?? null;
    while (cursor) {
      const next = await this.graphql<MondayNextItemsResponse>(
        `query ($cursor: String!, $limit: Int!) {
          next_items_page(cursor: $cursor, limit: $limit) {
            cursor
            items {
              id
              name
              state
              creator_id
              created_at
              updated_at
              board { id name }
              parent_item { id board { id } }
              column_values {
                id
                type
                value
                text
              }
            }
          }
        }`,
        { cursor, limit: ITEMS_PAGE_LIMIT }
      );
      const page = next?.next_items_page;
      if (page?.items?.length) {
        collected.push(...page.items);
      }
      cursor = page?.cursor ?? null;
    }

    if (
      typeof options?.updatedSinceMs === 'number'
      && Number.isFinite(options.updatedSinceMs)
      && options.updatedSinceMs > 0
    ) {
      const since = options.updatedSinceMs;
      return collected.filter((item) => {
        const updatedAt = parseMondayDate(item.updated_at);
        return updatedAt === null || updatedAt > since;
      });
    }
    return collected;
  }

  async getItem(itemId: string): Promise<MondayItem | null> {
    const data = await this.graphql<{ items?: MondayItem[] }>(
      `query ($ids: [ID!]) {
        items(ids: $ids) {
          id
          name
          state
          creator_id
          created_at
          updated_at
          board { id name }
          parent_item { id board { id } }
          column_values {
            id
            type
            value
            text
          }
        }
      }`,
      { ids: [itemId] }
    );
    const item = data?.items?.[0];
    return item ?? null;
  }

  async listBoardColumns(boardId: string): Promise<MondayColumn[]> {
    const data = await this.graphql<{ boards?: Array<{ columns?: MondayColumn[] }> }>(
      `query ($boardIds: [ID!]) {
        boards(ids: $boardIds) {
          columns { id title type }
        }
      }`,
      { boardIds: [boardId] }
    );
    return data?.boards?.[0]?.columns ?? [];
  }

  async createColumn(
    boardId: string,
    title: string,
    columnType: 'date' | 'people' | 'timeline' | 'text' | 'status'
  ): Promise<MondayColumn> {
    const data = await this.graphql<{ create_column?: MondayColumn }>(
      `mutation ($boardId: ID!, $title: String!, $columnType: ColumnType!) {
        create_column(board_id: $boardId, title: $title, column_type: $columnType) {
          id
          title
          type
        }
      }`,
      { boardId, title, columnType }
    );
    if (!data?.create_column) {
      throw new Error(`monday.com create_column returned no column (board ${boardId}, title ${title})`);
    }
    return data.create_column;
  }

  async createItem(
    boardId: string,
    name: string,
    columnValues: Record<string, unknown>
  ): Promise<MondayItem> {
    const data = await this.graphql<{ create_item?: MondayItem }>(
      `mutation ($boardId: ID!, $name: String!, $columnValues: JSON) {
        create_item(board_id: $boardId, item_name: $name, column_values: $columnValues) {
          id
          name
          state
          updated_at
          board { id name }
        }
      }`,
      { boardId, name, columnValues: JSON.stringify(columnValues) }
    );
    if (!data?.create_item) {
      throw new Error('monday.com create_item returned no item');
    }
    return data.create_item;
  }

  async createSubitem(
    parentItemId: string,
    name: string,
    columnValues: Record<string, unknown>
  ): Promise<MondayItem> {
    const data = await this.graphql<{ create_subitem?: MondayItem }>(
      `mutation ($parentItemId: ID!, $name: String!, $columnValues: JSON) {
        create_subitem(parent_item_id: $parentItemId, item_name: $name, column_values: $columnValues) {
          id
          name
          state
          updated_at
          board { id name }
          parent_item { id board { id } }
        }
      }`,
      { parentItemId, name, columnValues: JSON.stringify(columnValues) }
    );
    if (!data?.create_subitem) {
      throw new Error('monday.com create_subitem returned no item');
    }
    return data.create_subitem;
  }

  async updateItem(
    itemId: string,
    boardId: string,
    name: string,
    columnValues: Record<string, unknown>
  ): Promise<MondayItem> {
    // monday.com has no single "update item" mutation — change the name and
    // column values in one call via change_multiple_column_values + the
    // dedicated name column (item.name is the built-in "name" column).
    const merged = { ...columnValues, name };
    const data = await this.graphql<{ change_multiple_column_values?: MondayItem }>(
      `mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
        change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) {
          id
          name
          state
          updated_at
          board { id name }
        }
      }`,
      { boardId, itemId, columnValues: JSON.stringify(merged) }
    );
    if (!data?.change_multiple_column_values) {
      throw new Error('monday.com change_multiple_column_values returned no item');
    }
    return data.change_multiple_column_values;
  }

  async deleteItem(itemId: string): Promise<void> {
    try {
      await this.graphql<{ delete_item?: { id?: string } }>(
        `mutation ($itemId: ID!) {
          delete_item(item_id: $itemId) { id }
        }`,
        { itemId }
      );
    } catch (error) {
      // Treat already-missing items as a successful delete so retries don't fail.
      if (String(error).toLowerCase().includes('not found')) {
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

  private async graphql<T>(query: string, variables?: Record<string, unknown>, retried = false): Promise<T> {
    const token = await this.getAccessToken();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), MondayClient.REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(MondayClient.API_URL, {
        method: 'POST',
        headers: {
          Authorization: token,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'API-Version': MondayClient.API_VERSION
        },
        body: JSON.stringify({ query, variables: variables ?? {} }),
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(`monday.com API request timed out after ${MondayClient.REQUEST_TIMEOUT_MS}ms`);
      }
      throw error;
    }
    clearTimeout(timeoutId);

    if (response.status === 401 && !retried) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed) {
        return this.graphql<T>(query, variables, true);
      }
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`monday.com API failed (${response.status}): ${errorBody}`);
    }

    const text = await response.text();
    if (!text) {
      return undefined as unknown as T;
    }

    const parsed = JSON.parse(text) as GraphQLResponse<T>;
    if (parsed.errors?.length) {
      const message = parsed.errors.map((err) => err.message).join('; ');
      // monday.com surfaces auth issues as a GraphQL error; trigger refresh once.
      const unauthorized = parsed.errors.some(
        (err) => err.status === 401 || err.extensions?.code === 'UserUnauthorizedException'
      );
      if (unauthorized && !retried) {
        const refreshed = await this.refreshAccessToken();
        if (refreshed) {
          return this.graphql<T>(query, variables, true);
        }
      }
      throw new Error(`monday.com GraphQL error: ${message}`);
    }
    if (parsed.error_code || parsed.error_message) {
      throw new Error(`monday.com API error: ${parsed.error_code ?? ''} ${parsed.error_message ?? ''}`.trim());
    }
    return parsed.data as T;
  }
}

function toUserEntity(user: MondayUser): ExternalEntity {
  const id = String(user.id);
  const display = user.name || user.email || id;
  return {
    id,
    name: user.email ? `${display} (${user.email})` : display,
    email: user.email ?? null,
    isGuest: user.is_guest ?? false
  };
}

function toBoardEntity(board: MondayBoard): ExternalEntity {
  const workspaceName = board.workspace?.name ?? null;
  const path = [workspaceName, board.name].filter(Boolean).join(' / ');
  return {
    id: board.id,
    name: path || board.name,
    boardId: board.id,
    boardName: board.name,
    workspaceId: board.workspace?.id ?? null,
    workspaceName: workspaceName ?? null
  };
}

function parseMondayDate(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
