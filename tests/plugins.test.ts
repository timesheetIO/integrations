import fs from 'node:fs';
import path from 'node:path';
import type { IntegrationContext } from '@timesheet/integration-sdk';

import * as asanaHandlers from '../asana/src';
import * as clickupHandlers from '../clickup/src';
import * as googleCalendarHandlers from '../google-calendar/src';
import * as outlookCalendarHandlers from '../outlook-calendar/src';
import * as quickbooksHandlers from '../quickbooks/src';
import * as xeroHandlers from '../xero/src';

type HandlerModule = Record<string, unknown>;

type PluginFixture = {
  slug: string;
  manifestPath: string;
  handlers: HandlerModule;
};

const pluginFixtures: PluginFixture[] = [
  {
    slug: 'clickup',
    manifestPath: path.resolve(__dirname, '../clickup/manifest.json'),
    handlers: clickupHandlers
  },
  {
    slug: 'asana',
    manifestPath: path.resolve(__dirname, '../asana/manifest.json'),
    handlers: asanaHandlers
  },
  {
    slug: 'xero',
    manifestPath: path.resolve(__dirname, '../xero/manifest.json'),
    handlers: xeroHandlers
  },
  {
    slug: 'google-calendar',
    manifestPath: path.resolve(__dirname, '../google-calendar/manifest.json'),
    handlers: googleCalendarHandlers
  },
  {
    slug: 'outlook-calendar',
    manifestPath: path.resolve(__dirname, '../outlook-calendar/manifest.json'),
    handlers: outlookCalendarHandlers
  },
  {
    slug: 'quickbooks',
    manifestPath: path.resolve(__dirname, '../quickbooks/manifest.json'),
    handlers: quickbooksHandlers
  }
];

const createContext = (): IntegrationContext<{ syncDirection: string }> => ({
  userId: 'user-1',
  installationId: 'installation-1',
  config: { syncDirection: 'bidirectional' },
  data: ({
    getTask: async () => {
      throw new Error('not implemented in shared fixture');
    }
  } as unknown) as IntegrationContext['data'],
  credentials: {
    getAccessToken: async () => 'token',
    getApiKey: async () => 'api-key',
    refreshToken: async () => 'token-refreshed',
    getConnectionInfo: async (provider: string) => ({
      connected: true,
      provider,
      accountId: 'realm-1',
      accountName: 'Acme Corp'
    })
  },
  mappings: {
    get: async () => null,
    findByExternal: async () => null,
    list: async (input: { entity: string }) => {
      if (input.entity === 'project') {
        return [{ localId: 'project-1', externalId: 'external-project-1', syncStatus: 'SYNCED' }];
      }
      if (input.entity === 'user') {
        return [{ localId: 'user-1', externalId: 'external-user-1', syncStatus: 'SYNCED' }];
      }
      return [];
    },
    upsert: async () => {},
    delete: async () => {}
  },
  state: {
    get: async () => null,
    set: async () => {},
    delete: async () => {}
  },
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  }
});

const createFetchResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: {
    forEach: () => {}
  },
  json: async () => body,
  text: async () => JSON.stringify(body)
});

beforeAll(() => {
  const fetchMock = jest.fn(async (url: RequestInfo | URL) => {
    const requestUrl = String(url);

    if (requestUrl.includes('quickbooks.api.intuit.com') && requestUrl.includes('companyinfo')) {
      return createFetchResponse({ QueryResponse: { CompanyInfo: [{ CompanyName: 'Acme' }] } });
    }
    if (requestUrl.includes('quickbooks.api.intuit.com') && requestUrl.includes('timeactivity')) {
      return createFetchResponse({ QueryResponse: { TimeActivity: [] } });
    }
    if (requestUrl.includes('www.googleapis.com/calendar/v3/users/me/calendarList')) {
      return createFetchResponse({ items: [{ id: 'primary', summary: 'Primary Calendar' }] });
    }
    if (requestUrl.includes('www.googleapis.com/calendar/v3/calendars/')) {
      return createFetchResponse({ items: [], nextSyncToken: 'sync-token' });
    }
    if (requestUrl.includes('api.clickup.com/api/v2/team') && !requestUrl.includes('/space')) {
      return createFetchResponse({ teams: [{ id: 'clickup-team-1', name: 'Acme Team' }] });
    }
    if (requestUrl.includes('api.clickup.com/api/v2/list/') && requestUrl.includes('/task')) {
      return createFetchResponse({ tasks: [], last_page: true });
    }

    return createFetchResponse({});
  });

  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
});

describe('plugin manifests', () => {
  for (const fixture of pluginFixtures) {
    it(`${fixture.slug} manifest actions map to exported handlers`, () => {
      const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, 'utf8')) as {
        id: string;
        name: string;
        dataAccess: string[];
        actions: Array<{ id: string; handler: string }>;
        triggers: Array<{ id: string; type: string }>;
      };

      expect(manifest.id).toContain('sync');
      expect(manifest.name.length).toBeGreaterThan(0);
      expect(manifest.dataAccess.length).toBeGreaterThan(0);
      expect(manifest.actions.length).toBeGreaterThan(0);
      expect(manifest.triggers.length).toBeGreaterThan(0);

      for (const action of manifest.actions) {
        expect(typeof fixture.handlers[action.handler]).toBe('function');
      }
    });
  }
});

describe('plugin baseline behavior', () => {
  for (const fixture of pluginFixtures) {
    it(`${fixture.slug} testConnection and runFullSync return expected shape`, async () => {
      const testConnection = fixture.handlers.testConnection as (
        input: void,
        context: IntegrationContext
      ) => Promise<{ system: string; ok: boolean; installationId: string }>;
      const runFullSync = fixture.handlers.runFullSync as (
        input: void,
        context: IntegrationContext
      ) => Promise<{ system: string; status: string; syncedCount: number }>;

      const testConnectionResult = await testConnection(undefined, createContext());
      const runFullSyncResult = await runFullSync(undefined, createContext());

      expect(testConnectionResult.ok).toBe(true);
      expect(testConnectionResult.installationId).toBe('installation-1');
      expect(runFullSyncResult.status).toBe('completed');
      expect(typeof runFullSyncResult.system).toBe('string');
      expect(runFullSyncResult.syncedCount).toBe(0);
    });
  }
});
