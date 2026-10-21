import type { Transport } from './bridge';
import schema from './fixtures/graph-schema.json';

/**
 * A stand-in host for `vite dev` and tests: it answers the bridge's methods from fixtures, in the shapes the real host
 * sends (camelCase, `durationMs` a number, `outcome` a camelCase string).
 */

const account = {
  key: 'mock-account',
  username: 'analyst@contoso.example',
  tenantName: 'Contoso',
  tenantId: '00000000-0000-0000-0000-000000000001',
  clientId: '04b07795-8ddb-461a-bbee-02f9e1bf7b46',
  active: true,
  expired: false,
  scopes: ['Application.Read.All', 'User.Read.All'],
};

const runResult = {
  outcome: 'ok',
  message: null,
  error: null,
  columns: [
    { name: 'displayName', type: 'string' },
    { name: 'appId', type: 'string' },
    { name: 'createdDateTime', type: 'datetime' },
  ],
  rows: [
    ['Contoso Portal', '11111111-1111-1111-1111-111111111111', '2025-03-04T10:15:00Z'],
    ['Payroll Connector', '22222222-2222-2222-2222-222222222222', '2025-06-19T08:02:41Z'],
    ['Legacy Intranet', '33333333-3333-3333-3333-333333333333', '2024-11-27T14:30:12Z'],
  ],
  total: 3,
  tables: [
    {
      table: 'applications',
      requests: ['applications?$select=displayName,appId,createdDateTime&$top=999'],
      unfiltered: false,
      unreadable: [],
      denied: [],
      perObject: [],
      perObjectFailed: 0,
      perObjectCapped: false,
      perObjectCached: 0,
    },
  ],
  durationMs: 420,
  droppedValues: 0,
};

const defaultSettings = {
  version: 1,
  theme: 'dark',
  rawDefaultVersion: 'beta',
  signIn: { clientId: null, tenant: null },
  limits: {
    graphObjectsPerTable: 50000,
    fetchBudgetMb: 512,
    engineTimeoutSeconds: 120,
    engineHeapMb: 1024,
    engineWorkers: 2,
    perObjectReadsPerTable: 2000,
    perObjectCacheMinutes: 30,
    graphRowsPerRun: 50000,
  },
};

const RUN_DELAY_MS = 400;

interface MockRequest {
  id?: string;
  method?: string;
  params?: {
    tabId?: string;
    settings?: typeof defaultSettings;
    query?: SavedQueryInput;
    id?: string;
    session?: Record<string, unknown>;
    snippet?: { id?: string | null } & Record<string, unknown>;
  };
}

interface SavedQueryInput {
  id?: string | null;
  name: string;
  folder?: string | null;
  source?: string;
  text?: string;
  parameters?: unknown[];
}

interface SavedQuery extends SavedQueryInput {
  version: number;
  id: string;
  source: string;
  text: string;
  parameters: unknown[];
  createdAt: string;
  modifiedAt: string;
}

export function createMockTransport(): Transport {
  let receive: (message: string) => void = () => undefined;
  const runs = new Map<string, { id: string; timer: ReturnType<typeof setTimeout> }>();
  let settings = defaultSettings;
  const settingsAnswer = () => ({
    settings,
    limitsAppliedAt: 'startup',
    restartNeeded: JSON.stringify(settings.limits) !== JSON.stringify(defaultSettings.limits),
    corrupt: false,
  });

  const saved = new Map<string, SavedQuery>();
  let savedCounter = 0;
  let session: Record<string, unknown> = { version: 1, activeId: null, tabs: [] };
  const userSnippets = new Map<string, Record<string, unknown>>();

  const reply = (id: string, result: unknown) => receive(JSON.stringify({ id, result: result ?? null }));
  const fail = (id: string, code: string, message: string) => receive(JSON.stringify({ id, error: { code, message } }));

  function cancelRun(tabId: string) {
    const run = runs.get(tabId);
    if (run) {
      clearTimeout(run.timer);
      runs.delete(tabId);
      fail(run.id, 'cancelled', 'The run was cancelled.');
    }
  }

  function handle(request: MockRequest) {
    const { id, method, params } = request;
    if (!id) {
      return;
    }
    switch (method) {
      case 'app.info':
        reply(id, { version: '0.0.0-mock', platform: 'macos' });
        break;
      case 'settings.get':
        reply(id, settingsAnswer());
        break;
      case 'settings.set':
        settings = { ...(params?.settings ?? settings), version: 1 };
        reply(id, settingsAnswer());
        break;
      case 'library.list': {
        const queries = [...saved.values()].sort((a, b) => a.name.localeCompare(b.name));
        const folders = [...new Set(queries.map((q) => q.folder).filter((f): f is string => !!f))].sort();
        reply(id, { queries, folders, skipped: 0 });
        break;
      }
      case 'library.save': {
        const input = params?.query;
        if (!input) {
          fail(id, 'bad_request', 'The request has no query.');
          break;
        }
        const now = new Date().toISOString();
        const key = input.id ?? `00000000-0000-0000-0000-${String(++savedCounter).padStart(12, '0')}`;
        const query: SavedQuery = {
          version: 1,
          id: key,
          name: input.name,
          folder: input.folder ?? null,
          source: input.source ?? 'graph',
          text: input.text ?? '',
          parameters: input.parameters ?? [],
          createdAt: saved.get(key)?.createdAt ?? now,
          modifiedAt: now,
        };
        saved.set(key, query);
        reply(id, query);
        break;
      }
      case 'library.delete':
        saved.delete(params?.id ?? '');
        reply(id, null);
        break;
      case 'session.get':
        reply(id, { session, corrupt: false });
        break;
      case 'session.save':
        session = { ...(params?.session ?? session), version: 1 };
        reply(id, { dropped: 0 });
        break;
      case 'snippets.list':
        reply(id, { snippets: [...userSnippets.values()] });
        break;
      case 'snippets.save': {
        const input = params?.snippet;
        if (!input) {
          fail(id, 'bad_request', 'The request has no snippet.');
          break;
        }
        const key = input.id ?? `10000000-0000-0000-0000-${String(++savedCounter).padStart(12, '0')}`;
        const snippet = { description: '', group: null, parameters: [], ...input, id: key, builtIn: false };
        userSnippets.set(key, snippet);
        reply(id, snippet);
        break;
      }
      case 'snippets.delete':
        userSnippets.delete(params?.id ?? '');
        reply(id, null);
        break;
      case 'file.open':
      case 'file.saveAs':
        // The mock has no native dialog: it answers as if the user cancelled.
        reply(id, null);
        break;
      case 'recent.list':
        reply(id, { runs: [] });
        break;
      case 'recent.clear':
        reply(id, null);
        break;
      case 'cache.clear':
        reply(id, {});
        break;
      case 'schema.get':
        reply(id, schema);
        break;
      case 'account.list':
        reply(id, { accounts: [account], cache: 'persistent' });
        break;
      case 'account.signIn':
        reply(id, account);
        break;
      case 'account.use':
      case 'account.signOut':
        reply(id, null);
        break;
      case 'query.cancel':
        cancelRun(params?.tabId ?? '');
        reply(id, null);
        break;
      case 'query.complete':
        reply(id, []);
        break;
      case 'query.run': {
        const tabId = params?.tabId ?? '';
        cancelRun(tabId);
        const timer = setTimeout(() => {
          runs.delete(tabId);
          reply(id, runResult);
        }, RUN_DELAY_MS);
        runs.set(tabId, { id, timer });
        receive(JSON.stringify({ event: 'query.progress', data: { tabId, stage: 'fetch', detail: 'applications' } }));
        break;
      }
      default:
        fail(id, 'unknown_method', `Unknown method ${method ?? ''}.`);
    }
  }

  return {
    send: (message) => {
      // The real host answers asynchronously; so does the mock.
      queueMicrotask(() => handle(JSON.parse(message) as MockRequest));
    },
    onMessage: (callback) => {
      receive = callback;
    },
  };
}
