import type { Transport } from './bridge';
import type { QueryOptions } from './wire';
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
      relationships: [],
      unlicensed: [],
      unlicensedReason: null,
      licenseLeftOut: [],
    },
  ],
  durationMs: 420,
  droppedValues: 0,
  runId: 'mock-run',
  diagnostics: [
    {
      atMs: 10,
      kind: 'request',
      detail: 'GET applications?$select=displayName,appId,createdDateTime&$top=999',
      status: 200,
      durationMs: 300,
      bytes: 2048,
    },
  ],
};

const explainView = {
  error: null,
  refusal: null,
  tables: [
    {
      table: 'applications',
      url: "applications?$select=displayName%2CappId%2CcreatedDateTime%2Cid&$filter=displayName%20eq%20'Payroll'&$top=999",
      select: ['displayName', 'appId', 'createdDateTime', 'id'],
      filter: "displayName eq 'Payroll'",
      top: null,
      pushed: ["displayName == 'Payroll'"],
      local: [{ condition: "appId has 'abc'", reason: "Graph doesn't allow this operator on appId" }],
      perObject: [],
      permissions: ['Application.Read.All'],
      docsUrl: 'https://learn.microsoft.com/graph/api/resources/application?view=graph-rest-beta',
      orderBy: null,
      count: false,
      headers: [],
      licenseLeftOut: [],
      missingLicense: null,
      missingLicenseSource: null,
      relationships: [],
      filteredLocally: false,
    },
  ],
  limits: { objectsPerTable: 50000, fetchBudgetMb: 512, perObjectReadsPerTable: 2000, relationshipObjectsPerTable: 100, relationshipEntriesPerObject: 1000 },
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
    argRowsPerRun: 50000,
  },
};

/** `arm.subscriptions`', `arm.managementGroups`' and `arm.resourceTypes`' answers, as `ArmHandler` writes them. */
const armSubscriptions = {
  subscriptions: [
    { id: '00000000-0000-0000-0000-000000000011', name: 'Production', tenantId: account.tenantId, state: 'Enabled' },
    { id: '00000000-0000-0000-0000-000000000012', name: 'Development', tenantId: account.tenantId, state: 'Enabled' },
  ],
};
const armManagementGroups = { groups: [{ name: 'contoso-platform', displayName: 'Platform' }] };
const armResourceTypes = {
  types: ['microsoft.compute/virtualmachines', 'microsoft.keyvault/vaults', 'microsoft.storage/storageaccounts'],
};
/** `schema.licenses` as for a tenant with Microsoft Entra ID P1 and no Intune: sign-in logs and sign-in activity are licensed,
 * managed devices aren't. */
const entraP1OrP2 = {
  license: 'Microsoft Entra ID P1 or P2',
  plans: ['AAD_PREMIUM', 'AAD_PREMIUM_P2'],
  source: 'https://learn.microsoft.com/graph/api/resources/signin?view=graph-rest-1.0',
  state: 'available',
};
const schemaLicenses = {
  known: true,
  reason: null,
  tables: {
    auditLogs_signIns: entraP1OrP2,
    deviceManagement_managedDevices: {
      license: 'Microsoft Intune',
      plans: ['INTUNE_A', 'INTUNE_EDU', 'INTUNE_SMBIZ', 'INTUNE_A_GOV', 'INTUNE_A_VL'],
      source: 'https://learn.microsoft.com/graph/api/resources/intune-shared-manageddevice?view=graph-rest-beta',
      state: 'missing',
    },
  },
  columns: {
    users: { signInActivity: { ...entraP1OrP2, source: 'https://learn.microsoft.com/graph/api/resources/user?view=graph-rest-1.0#properties' } },
  },
};

/** The columns Graph lists for a user without `$select`. */
const listedUserColumns = [
  'businessPhones',
  'displayName',
  'givenName',
  'id',
  'jobTitle',
  'mail',
  'mobilePhone',
  'officeLocation',
  'preferredLanguage',
  'surname',
  'userPrincipalName',
];

/** A column as `SchemaHandler` writes it for advanced hunting and Resource Graph: Graph's own fields are null. */
const column = (name: string, type: string) => ({ name, type, description: '', filterable: null, listable: null, complexType: null, collection: false });
const table = (name: string, description: string, columns: [string, string][]) => ({
  name,
  path: null,
  area: null,
  description,
  docsUrl: null,
  permissions: null,
  columns: columns.map(([n, t]) => column(n, t)),
});

/** `schema.get {source: "hunting"}`: a few of the tenant's tables and the four built-in functions, as `SchemaView.From` writes
 * a tenant's schema (`origin: tenant`). */
const huntingSchema = {
  source: 'hunting',
  origin: 'tenant',
  fallbackReason: null,
  generatedAt: '2026-10-21T06:12:00Z',
  tables: [
    table('AADSignInEventsBeta', 'Microsoft Entra sign-ins.', [
      ['Timestamp', 'datetime'],
      ['AccountUpn', 'string'],
      ['IPAddress', 'string'],
      ['Application', 'string'],
      ['ErrorCode', 'int'],
      ['Country', 'string'],
    ]),
    table('DeviceInfo', 'Machine information, including OS information.', [
      ['Timestamp', 'datetime'],
      ['DeviceId', 'string'],
      ['DeviceName', 'string'],
      ['OSPlatform', 'string'],
    ]),
    table('DeviceProcessEvents', 'Process creation and related events.', [
      ['Timestamp', 'datetime'],
      ['DeviceId', 'string'],
      ['DeviceName', 'string'],
      ['FileName', 'string'],
      ['ProcessCommandLine', 'string'],
      ['SHA1', 'string'],
    ]),
    table('IdentityLogonEvents', 'Authentication events on Active Directory and Microsoft online services.', [
      ['Timestamp', 'datetime'],
      ['AccountUpn', 'string'],
      ['ActionType', 'string'],
      ['LogonType', 'string'],
      ['IPAddress', 'string'],
    ]),
  ],
  functions: [
    {
      name: 'AssignedIPAddresses',
      description: 'The latest IP addresses assigned to a device, or those it had at a point in time.',
      parameters: [
        { name: 'DeviceId', type: 'string' },
        { name: 'Timestamp', type: 'datetime' },
      ],
    },
    {
      name: 'DeviceFromIP',
      description: 'The devices that were assigned an IP address at a point in time.',
      parameters: [
        { name: 'IP', type: 'string' },
        { name: 'Timestamp', type: 'datetime' },
      ],
    },
    {
      name: 'FileProfile',
      description: 'Adds what Microsoft knows about each file to the rows, such as prevalence and signer.',
      parameters: [
        { name: 'SHA1', type: 'string' },
        { name: 'limit', type: 'long' },
      ],
    },
    { name: 'SeenBy', description: 'The onboarded devices that have seen a device through device discovery.', parameters: [{ name: 'DeviceId', type: 'string' }] },
  ],
  complexTypes: {},
};

const ARG_COLUMNS: [string, string][] = [
  ['id', 'string'],
  ['name', 'string'],
  ['type', 'string'],
  ['tenantId', 'string'],
  ['location', 'string'],
  ['resourceGroup', 'string'],
  ['subscriptionId', 'string'],
  ['properties', 'dynamic'],
  ['tags', 'dynamic'],
];

/** `schema.get {source: "arg"}`: some of the bundled Resource Graph tables (`SchemaView.FromArg`). */
const argSchema = {
  source: 'arg',
  origin: 'builtIn',
  fallbackReason: null,
  generatedAt: '2026-10-21T00:00:00Z',
  tables: [
    table('Resources', 'Resources in the subscriptions the account can read.', ARG_COLUMNS),
    table('ResourceContainers', 'Subscriptions, resource groups and management groups.', ARG_COLUMNS),
    table('AuthorizationResources', 'Role assignments and role definitions.', ARG_COLUMNS),
    table('SecurityResources', 'Microsoft Defender for Cloud assessments and alerts.', ARG_COLUMNS),
  ],
  functions: [],
  complexTypes: {},
};

/** `query.run`'s answer for advanced hunting and Resource Graph: no Graph tables, one request in the log (per page). */
function serverRunResult(source: 'hunting' | 'arg') {
  const detail = source === 'hunting' ? 'POST security/runHuntingQuery' : 'POST providers/Microsoft.ResourceGraph/resources';
  return {
    ...runResult,
    columns: [
      { name: 'Timestamp', type: 'datetime' },
      { name: 'Name', type: 'string' },
    ],
    rows: [
      ['2026-10-21T09:38:12Z', source === 'hunting' ? 't.dahl@contoso.example' : 'stcontosoweb01'],
      ['2026-10-21T08:57:31Z', source === 'hunting' ? 'svc-backup@contoso.example' : 'stsharedlogs'],
    ],
    total: 2,
    tables: [],
    diagnostics: [{ atMs: 5, kind: 'request', detail, status: 200, durationMs: 380, bytes: 1024 }],
  };
}

/** Built-in hunting and Resource Graph snippets, so the Snippets panel has some for each source. */
const builtInHuntingSnippet = {
  id: '5f0e6a6e-6d0a-4a55-9a53-0b7e3a1c0101',
  source: 'hunting',
  name: 'Sign-ins from TOR exits',
  description: 'Successful sign-ins from addresses in the list.',
  text: 'AADSignInEventsBeta\n| where Timestamp > ago({lookback}) and ErrorCode == 0\n| project Timestamp, AccountUpn, Application, IPAddress, Country',
  builtIn: true,
  group: 'Threat hunting',
  parameters: [{ name: 'lookback', type: 'timespan', value: '7d', required: false, choices: ['1d', '7d', '30d'] }],
};
const builtInArgSnippet = {
  id: '5f0e6a6e-6d0a-4a55-9a53-0b7e3a1c0201',
  source: 'arg',
  name: 'Public storage accounts',
  description: 'Storage accounts that allow public blob access.',
  text: 'Resources\n| where type =~ "microsoft.storage/storageaccounts"\n| where properties.allowBlobPublicAccess == true\n| project name, resourceGroup, subscriptionId, location',
  builtIn: true,
  group: 'Azure posture',
  parameters: [],
};

/** `raw.send`'s and `raw.next`'s answer, as the host builds it: never a `Set-Cookie` or `Authorization` header. */
function rawResponse(url: string, accountKey: string) {
  const body = JSON.stringify({
    '@odata.context': url,
    value: [{ id: '11111111-1111-1111-1111-111111111111', displayName: 'Contoso Portal' }],
  });
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'request-id': 'mock-request' },
    body,
    durationMs: 120,
    nextLink: null,
    truncated: false,
    accountKey,
  };
}

/** One of the host's built-in snippets (`Snippets/builtin-snippets.json`); `snippets.list` answers the built-in ones first. */
const builtInSnippet = {
  id: '5f0e6a6e-6d0a-4a55-9a53-0b7e3a1c0001',
  source: 'graph',
  name: 'Expired app credentials',
  description: 'Application secrets and certificates that ended more than the grace period ago, one row per app.',
  text:
    'union\n    (applications | mv-expand cred = passwordCredentials | extend credKind = "secret"),\n' +
    '    (applications | mv-expand cred = keyCredentials | extend credKind = "certificate")\n' +
    '| where todatetime(cred.endDateTime) < now() - {graceDays}\n' +
    '| summarize expired = count(), kinds = make_set(credKind) by displayName, appId\n| order by expired desc',
  builtIn: true,
  group: 'Identity checks',
  parameters: [{ name: 'graceDays', type: 'timespan', value: '0d', required: false, choices: ['0d', '7d', '30d'] }],
};

const RUN_DELAY_MS = 400;

interface MockRequest {
  id?: string;
  method?: string;
  params?: {
    tabId?: string;
    runId?: string;
    adminScopes?: string[];
    settings?: typeof defaultSettings;
    query?: SavedQueryInput;
    id?: string;
    session?: Record<string, unknown>;
    snippet?: { id?: string | null } & Record<string, unknown>;
    version?: string;
    path?: string;
    nextLink?: string;
    accountKey?: string;
    options?: QueryOptions | null;
    source?: string;
    kql?: string;
    parameters?: unknown[];
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a timespan is in milliseconds (a duration in days, weeks or hours, or an interval `start/end`), or null when the
 * mock can't read it. */
function timespanMs(timespan: string): number | null {
  const [start, end, ...rest] = timespan.split('/');
  if (end !== undefined && rest.length === 0) {
    const ms = Date.parse(end) - Date.parse(start ?? '');
    return Number.isNaN(ms) ? null : ms;
  }
  const match = /^P(?:(\d+)W|(\d+)D)?(?:T(\d+)H)?$/.exec(timespan);
  if (!match || timespan === 'P') {
    return null;
  }
  return (Number(match[1] ?? 0) * 7 + Number(match[2] ?? 0)) * DAY_MS + Number(match[3] ?? 0) * 3600000;
}

/** What the host would refuse in a run's options (`QueryOptions.Problem`, in its words), or null. */
function optionsProblem(options: QueryOptions | null | undefined): string | null {
  if (options?.timespan) {
    const ms = timespanMs(options.timespan);
    if (ms === null || ms <= 0) {
      return 'The timespan must be an ISO 8601 duration such as P7D, or an interval start/end.';
    }
    if (ms > 30 * DAY_MS) {
      return 'The timespan can cover at most 30 days.';
    }
  }
  const scope = options?.scope;
  if (scope?.kind === 'subscriptions' && (scope.ids.length === 0 || scope.ids.length > 100)) {
    return 'Pick 1 to 100 subscriptions.';
  }
  if (scope?.kind === 'managementGroup' && scope.ids.length !== 1) {
    return 'Pick one management group.';
  }
  return null;
}

interface SavedQueryInput {
  id?: string | null;
  name: string;
  folder?: string | null;
  source?: string;
  text?: string;
  parameters?: unknown[];
  options?: QueryOptions | null;
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

const graphId = '00000003-0000-0000-c000-000000000000';
const armId = '797f4846-ba00-4fd7-ba43-dac1f8f63013';
function plannedPermission(name: string, tables: string[], ticked: boolean, adminConsent = true, description = '', unlocks: string | null = null) {
  return { resource: 'Microsoft Graph', resourceAppId: graphId, name, adminConsent, description, tables, unlocks, ticked };
}

/** `entraApp.plan`'s answer: a small plan with the three groups, Mail unticked, and tables that overlap between permissions. */
const entraAppPlan = {
  canCreate: true,
  defaultName: 'Kustodian (kari@contoso.com)',
  tenantId: '9a1c0000-0000-0000-0000-00000000d03e',
  tenantName: 'Contoso Ltd',
  tablesWithData: 12,
  tablesWithoutData: 4,
  writeOnlyTables: 1,
  groups: [
    {
      id: 'graph',
      title: 'Graph',
      subgroups: [
        {
          title: 'Users, groups and directory',
          permissions: [
            plannedPermission('Directory.Read.All', ['users', 'groups', 'devices'], true, true, 'Read directory data'),
            plannedPermission('User.Read.All', ['users'], true, true, 'Read all users'),
            plannedPermission('Group.Read.All', ['groups'], true, true, ''),
          ],
        },
        { title: 'Mail, Teams and files', permissions: [plannedPermission('Mail.Read', ['messages', 'attachments'], false, false, 'Read your mail')] },
      ],
    },
    {
      id: 'security',
      title: 'Security',
      subgroups: [
        {
          title: 'Advanced hunting',
          permissions: [plannedPermission('ThreatHunting.Read.All', [], true, true, 'Run advanced hunting queries', 'Defender advanced hunting tabs')],
        },
      ],
    },
    {
      id: 'azure',
      title: 'Azure Resources',
      subgroups: [
        {
          title: 'Resource Graph',
          permissions: [
            { resource: 'Azure Service Management', resourceAppId: armId, name: 'user_impersonation', adminConsent: false, description: 'Access Azure Service Management as you', tables: [], unlocks: 'Resource Graph', ticked: true },
          ],
        },
      ],
    },
  ],
};

const entraAppCreated = {
  appId: '11111111-2222-3333-4444-555555555555',
  objectId: '66666666-7777-8888-9999-000000000000',
  servicePrincipalId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  tenantId: entraAppPlan.tenantId,
  ownerAdded: true,
  ownerMessage: null,
  dropped: [],
  servicePrincipalMessage: null,
  adminScopes: ['Directory.Read.All', 'User.Read.All', 'Group.Read.All', 'ThreatHunting.Read.All'],
};

export function createMockTransport(): Transport {
  let receive: (message: string) => void = () => undefined;
  const runs = new Map<string, { id: string; timer: ReturnType<typeof setTimeout> }>();
  let settings = defaultSettings;
  const settingsAnswer = () => ({
    settings,
    limitsAppliedAt: 'startup',
    restartNeeded: JSON.stringify(settings.limits) !== JSON.stringify(defaultSettings.limits),
    corrupt: false,
    unreadable: false,
  });

  const saved = new Map<string, SavedQuery>();
  let savedCounter = 0;
  let session: Record<string, unknown> = { version: 1, activeId: null, tabs: [] };
  const recent: Record<string, unknown>[] = [];
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
          options: input.options ?? null,
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
        reply(id, { snippets: [builtInSnippet, builtInHuntingSnippet, builtInArgSnippet, ...userSnippets.values()] });
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
        reply(id, { runs: recent.slice(0, 100) });
        break;
      case 'recent.clear':
        recent.length = 0;
        reply(id, null);
        break;
      case 'cache.clear':
        reply(id, {});
        break;
      case 'schema.get':
        // As `SchemaHandler`: Graph's bundled schema, the tenant's hunting schema, the bundled Resource Graph tables.
        switch (params?.source) {
          case 'graph':
            reply(id, schema);
            break;
          case 'hunting':
            reply(id, huntingSchema);
            break;
          case 'arg':
            reply(id, argSchema);
            break;
          default:
            fail(id, 'bad_request', `Unknown source ${params?.source ?? ''}.`);
        }
        break;
      case 'schema.licenses':
        // As `SchemaHandler`: Graph only.
        if (params?.source === 'graph') {
          reply(id, schemaLicenses);
        } else {
          fail(id, 'bad_request', `Unknown source ${params?.source ?? ''}.`);
        }
        break;
      case 'schema.listedByDefault':
        // As `SchemaHandler`: Graph only; the tables read so far, here users as Graph lists them without $select.
        if (params?.source === 'graph') {
          reply(id, { tables: { users: listedUserColumns } });
        } else {
          fail(id, 'bad_request', `Unknown source ${params?.source ?? ''}.`);
        }
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
      case 'account.consent':
        reply(id, {});
        break;
      case 'entraApp.plan':
        reply(id, entraAppPlan);
        break;
      case 'entraApp.create': {
        const steps = ['lookUp', 'createApp', 'addOwner', 'createServicePrincipal'];
        steps.forEach((step, i) => setTimeout(() => receive(JSON.stringify({ event: 'entraApp.step', data: { step } })), i * 40));
        setTimeout(() => reply(id, entraAppCreated), steps.length * 40);
        break;
      }
      case 'entraApp.retryServicePrincipal':
        reply(id, entraAppCreated);
        break;
      case 'entraApp.consentStatus':
        reply(id, { granted: [], missing: params?.adminScopes ?? [] });
        break;
      case 'entraApp.canGrant':
        reply(id, { canGrant: true });
        break;
      case 'entraApp.openConsent':
      case 'entraApp.openPortal':
        reply(id, {});
        break;
      case 'entraApp.consentLink':
        reply(id, { url: `https://login.microsoftonline.com/${entraAppPlan.tenantId}/v2.0/adminconsent?client_id=${entraAppCreated.appId}` });
        break;
      case 'arm.subscriptions':
        reply(id, armSubscriptions);
        break;
      case 'arm.managementGroups':
        reply(id, armManagementGroups);
        break;
      case 'arm.resourceTypes':
        reply(id, armResourceTypes);
        break;
      case 'query.cancel':
        cancelRun(params?.tabId ?? '');
        reply(id, null);
        break;
      case 'query.complete':
        if (params?.source !== 'graph') {
          fail(id, 'bad_request', 'Completion comes from the editor for this source.');
          break;
        }
        reply(id, []);
        break;
      case 'query.explain':
        if (params?.source !== 'graph') {
          fail(id, 'bad_request', 'Explain is only available for Microsoft Graph.');
          break;
        }
        reply(id, explainView);
        break;
      case 'query.run': {
        // As `QueryOptions.Problem`: options that aren't valid are a bad_request, and nothing runs (ruling 1).
        const problem = optionsProblem(params?.options);
        if (problem) {
          fail(id, 'bad_request', problem);
          break;
        }
        const tabId = params?.tabId ?? '';
        // As the host does: the UI's run id when it sends one, else one of the mock's own.
        const runId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params?.runId ?? '')
          ? (params?.runId ?? '')
          : runResult.runId;
        cancelRun(tabId);
        const timer = setTimeout(() => {
          runs.delete(tabId);
          const source = params?.source;
          const result = { ...(source === 'hunting' || source === 'arg' ? serverRunResult(source) : runResult), runId };
          // As the host's Recent: newest first, with the run's options, so "open again" brings them back.
          recent.unshift({
            id: runId,
            source: source ?? 'graph',
            text: params?.kql ?? '',
            parameters: params?.parameters ?? [],
            startedAt: new Date().toISOString(),
            durationMs: result.durationMs,
            rows: result.total,
            outcome: result.outcome,
            options: params?.options ?? null,
          });
          reply(id, result);
        }, RUN_DELAY_MS);
        runs.set(tabId, { id, timer });
        receive(JSON.stringify({ event: 'query.progress', data: { tabId, runId, stage: 'fetch', detail: 'applications' } }));
        break;
      }
      case 'raw.send':
        if (!params?.version || !params.path) {
          fail(id, 'bad_request', 'A raw request needs a version and a path.');
          break;
        }
        reply(id, rawResponse(`https://graph.microsoft.com/${params.version}/${params.path}`, account.key));
        break;
      case 'raw.next':
        if (!params?.nextLink || !params.accountKey) {
          fail(id, 'bad_request', 'A next request needs a nextLink and the accountKey of its first page.');
          break;
        }
        reply(id, rawResponse(params.nextLink, params.accountKey));
        break;
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
