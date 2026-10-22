/** The shapes the host sends over the bridge (camelCase, as its `BridgeJson` writes them). */

/** `raw` is the raw Graph request tab (Task 12); it never runs KQL. */
export type Source = 'graph' | 'hunting' | 'arg' | 'raw';

/** A column. `filterable`, `listable` and `complexType` are Graph's; other sources send null. */
export interface SchemaColumn {
  name: string;
  type: string;
  description: string;
  filterable: boolean | null;
  listable: boolean | null;
  complexType: string | null;
  collection: boolean;
}

/** A table. `path`, `docsUrl` and `permissions` are Graph's; other sources send null. */
export interface SchemaTable {
  name: string;
  /** The Graph collection relative to the version (`auditLogs/signIns` for `auditLogs_signIns`). */
  path: string | null;
  /** The data area the schema panel groups a Graph table under (the host's `graph-areas.json`; `Other` when unmapped); null for
   * other sources. */
  area: string | null;
  description: string;
  docsUrl: string | null;
  permissions: string[] | null;
  columns: SchemaColumn[];
}

/** A function a source offers (advanced hunting's built-in and saved functions). */
export interface SchemaFunction {
  name: string;
  description: string;
  parameters: { name: string; type: string }[];
}

export interface SchemaField {
  name: string;
  type: string;
  collection: boolean;
  complexType?: string | null;
  description: string;
}

/** `schema.get`'s answer. `source` says where the schema came from. `origin` is `tenant` (read for the account) or `builtIn`
 * (bundled; Graph's always is), and `fallbackReason` says why a tenant's schema isn't shown. */
export interface SchemaView {
  source: string;
  origin: 'tenant' | 'builtIn';
  fallbackReason: string | null;
  generatedAt: string;
  tables: SchemaTable[];
  functions: SchemaFunction[];
  complexTypes: Record<string, SchemaField[]>;
}

/** `schema.listedByDefault`'s answer: for the active account, the columns Graph lists by default (without `$select`) for each
 * table read so far, by table name. A table not in it hasn't been read yet. */
export interface ListedByDefault {
  tables: Record<string, string[]>;
}

/** Whether the tenant has a license a Graph table or column needs: `unknown` when its licenses couldn't be read. */
export type LicenseState = 'available' | 'missing' | 'unknown';

/** A license a Graph table or column needs: in Microsoft's words, the service plans any one of which provides it, the Learn
 * page that says so, and whether the active account's tenant has it. */
export interface LicenseInfo {
  license: string;
  plans: string[];
  source: string;
  state: LicenseState;
}

/** `schema.licenses`' answer: whether the tenant's licenses are known (else `reason` says why), and the licenses Graph tables
 * need (by table name) and columns need (by table name, then column). A table or column not in it needs none. */
export interface SchemaLicenses {
  known: boolean;
  reason: string | null;
  tables: Record<string, LicenseInfo>;
  columns: Record<string, Record<string, LicenseInfo>>;
}

/** A column a run didn't read because the tenant lacks the license it needs (its values are empty). */
export interface LicenseLeftOut {
  column: string;
  license: string;
  source: string;
}

export type RunOutcome =
  | 'ok'
  | 'queryError'
  | 'refused'
  | 'noPermission'
  | 'throttled'
  | 'tooLarge'
  | 'engineTimeout'
  | 'engineMemory'
  | 'signInNeeded'
  /** An ARM token needs the user: `account.consent {key, audience: "arm"}` grants it; the account stays signed in. */
  | 'consentNeeded'
  /** A table the query reads needs a license the tenant doesn't have: nothing was read. */
  | 'unlicensed'
  | 'failed';

/** What one relationship column's reads did. `truncated`: objects whose list hit `entryCap`; `refused`: objects Graph refused for
 * permission; `capped`: the table had more objects than are read for relationships; `filteredLocally`: the filter ran here, so
 * every listed object was read. */
export interface RelationshipFetch {
  column: string;
  objects: number;
  truncated: number;
  entryCap: number;
  refused: number;
  permissions: string[];
  capped: boolean;
  filteredLocally: boolean;
}

export interface TableFetch {
  table: string;
  requests: string[];
  unfiltered: boolean;
  unreadable: string[];
  denied: string[];
  perObject: string[];
  perObjectFailed: number;
  perObjectCapped: boolean;
  perObjectCached: number;
  /** Relationship columns (navigation properties such as `users.memberOf`), each read one object at a time. */
  relationships: RelationshipFetch[];
  /** Columns left out after Graph refused the list for a license or feature the tenant lacks; `unlicensedReason` is Graph's message. */
  unlicensed: string[];
  unlicensedReason: string | null;
  /** Columns the query touches that weren't read, as the tenant is known to lack their license. */
  licenseLeftOut: LicenseLeftOut[];
}

export interface ResultColumn {
  name: string;
  type: string;
}

/** `query.run`'s answer. */
export interface RunResult {
  outcome: RunOutcome;
  message: string | null;
  error: { line: number; column: number; message: string } | null;
  columns: ResultColumn[];
  rows: unknown[][];
  total: number;
  tables: TableFetch[];
  durationMs: number;
  droppedValues: number;
  /** The run's id: the `runId` sent with `query.run` when it is a GUID ("D" format), else one the host chose. Its
   * `query.progress` events carry it too. */
  runId: string;
  /** The run's log, in time order. */
  diagnostics: DiagnosticEntry[];
}

/** One line of a run's diagnostics log. A request's `detail` is its method and URL relative to the Graph version. */
export interface DiagnosticEntry {
  /** Milliseconds since the run started. */
  atMs: number;
  kind: 'request' | 'retry' | 'throttled' | 'probe' | 'per-object' | 'cache' | 'engine';
  detail: string;
  status: number | null;
  durationMs: number | null;
  bytes: number | null;
}

/** A `query.progress` event. */
export interface RunProgress {
  tabId: string;
  runId: string;
  stage: string;
  detail: string;
}

/** A field `query.complete` offers after a dot. */
export interface CompletionItem {
  label: string;
  kind: string;
  type: string;
  description: string;
}

export interface AccountInfo {
  key: string;
  username: string;
  tenantName: string;
  tenantId: string;
  clientId: string;
  active: boolean;
  expired: boolean;
  scopes: string[];
}

/** `account.list`'s answer. `memoryOnly`: tokens aren't kept after the app closes, because of `cacheReason`. */
export interface AccountList {
  accounts: AccountInfo[];
  cache: 'persistent' | 'memoryOnly';
  cacheReason?: string;
}

/** The Azure CLI's public client, Kustodian's default. */
export const AZURE_CLI_CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';

/** A query's parameter as saved with it: its last value, and the choices a list offers. */
export interface ParameterDef {
  name: string;
  type: string;
  value: string;
  required: boolean;
  choices?: string[] | null;
}

/** A parameter's value as `query.run` takes it. */
export interface ParameterValue {
  name: string;
  type: string;
  value: string;
  required: boolean;
}

/** Where an Azure Resource Graph query looks: subscription GUIDs (1 to 100), one management group's name, or every
 * subscription the account can see (no ids). */
export interface ArgScope {
  kind: 'subscriptions' | 'managementGroup' | 'all';
  ids: string[];
}

/** A run's options for the server-side sources: advanced hunting's `timespan` (an ISO 8601 duration such as `P7D`, or an
 * interval `start/end`, at most 30 days) and Resource Graph's `scope`. Null parts, and null options, take the source's defaults
 * (P30D; "all I can see"). Graph ignores both. */
export interface QueryOptions {
  timespan: string | null;
  scope: ArgScope | null;
}

/** `query.run`'s params. The host refuses options that aren't valid with `bad_request`. */
export interface QueryRunParams {
  tabId: string;
  source: Source;
  kql: string;
  refresh: boolean;
  parameters?: ParameterValue[];
  runId?: string;
  options?: QueryOptions | null;
}

/** A raw request header as the raw tab's editor holds it. */
export interface RawTabHeader {
  name: string;
  value: string;
}

/** A raw request tab's request as the session keeps it: the version (null: the settings' default) and the headers. The host
 * keeps only headers the raw tab could send (never `Authorization`, `Host`, `Cookie` or `Accept-Encoding`), at most 20 and
 * 8 KB in all. */
export interface RawTabRequest {
  version: string | null;
  headers: RawTabHeader[];
}

/** A tab as `session.json` keeps it. The host nulls a `filePath` the user didn't choose. `raw` is a raw request tab's request,
 * and null (or left out) for other tabs. `options` are the tab's timespan or scope; null (or left out) for none. */
export interface SessionTab {
  id: string;
  source: Source;
  title: string;
  text: string;
  dirty: boolean;
  savedId: string | null;
  parameters: ParameterDef[];
  filePath: string | null;
  raw?: RawTabRequest | null;
  options?: QueryOptions | null;
}

export interface Session {
  version: number;
  activeId: string | null;
  tabs: SessionTab[];
}

/** `session.get`'s answer. `corrupt`: the file was moved aside and the session is empty. */
export interface SessionAnswer {
  session: Session;
  corrupt: boolean;
}

export interface SavedQuery {
  version: number;
  id: string;
  name: string;
  folder: string | null;
  source: Source;
  text: string;
  parameters: ParameterDef[];
  createdAt: string;
  modifiedAt: string;
  /** The timespan or scope saved with the query; null (or left out) for none. */
  options?: QueryOptions | null;
}

/** `library.list`'s answer. `skipped`: files that couldn't be read and were moved aside. */
export interface LibraryList {
  queries: SavedQuery[];
  folders: string[];
  skipped: number;
}

export interface Snippet {
  id: string;
  source: Source;
  name: string;
  description: string;
  text: string;
  builtIn: boolean;
  group: string | null;
  parameters: ParameterDef[];
}

/** A subscription the account can see, as `arm.subscriptions` lists it: `id` is the subscription GUID a scope names. */
export interface ArmSubscription {
  id: string;
  name: string;
  tenantId: string;
  state: string;
}

/** `arm.subscriptions`' answer. */
export interface ArmSubscriptionsAnswer {
  subscriptions: ArmSubscription[];
}

/** A management group: `name` is what a scope names, `displayName` what the picker shows. */
export interface ArmManagementGroup {
  name: string;
  displayName: string;
}

/** `arm.managementGroups`' answer. `note` says why `groups` is empty when they can't be listed. */
export interface ArmManagementGroupsAnswer {
  groups: ArmManagementGroup[];
  note?: string;
}

/** `arm.resourceTypes`' answer: the account's resource types (`Resources | distinct type`), cached by the host for 24 hours. */
export interface ArmResourceTypesAnswer {
  types: string[];
}

export type Theme = 'dark' | 'light' | 'system';

export interface AppSettings {
  version: number;
  theme: Theme;
  rawDefaultVersion: string;
  signIn: { clientId: string | null; tenant: string | null };
  limits: Record<string, number>;
}

/** `settings.get`'s and `settings.set`'s answer. `corrupt`: the settings file was set aside as corrupt this session;
 * `unreadable`: it couldn't be read (or set aside) at all. Either way the defaults are in use. */
export interface SettingsAnswer {
  settings: AppSettings;
  restartNeeded: boolean;
  corrupt: boolean;
  unreadable: boolean;
}

/** One run as `recent.list` keeps it (newest first): no rows. `outcome` is a {@link RunOutcome}, or another the host added. */
export interface RecentRun {
  id: string;
  source: Source;
  text: string;
  parameters: ParameterValue[];
  startedAt: string;
  durationMs: number;
  rows: number;
  outcome: string;
  /** The options the run had; null (or left out) for none. */
  options?: QueryOptions | null;
}

/** A file dialog's filter: a name and extensions without the dot. */
export interface FileFilter {
  name: string;
  extensions: string[];
}

/** `file.open`'s answer; null when the dialog was cancelled. */
export interface OpenedFile {
  path: string;
  name: string;
  text: string;
}

/** `file.saveAs`'s answer; null when the dialog was cancelled. */
export interface SavedFile {
  path: string;
  name: string;
}

/** A `where` condition Explain says runs locally, and why it isn't sent to Graph. */
export interface LocalCondition {
  condition: string;
  reason: string;
}

/** What a Graph run would ask one table for. `url` is relative to the Graph version (Graph KQL tabs always use beta). `top`: the
 * query's `take` sent to Graph as `$top`; the read stops after that many objects. `orderBy`: the sort sent with it as
 * `$orderby` (OData, `createdDateTime desc`). `count`: the query only counts, and Graph is asked for the count (`url` is the
 * count's). `headers`: headers sent besides the token (`ConsistencyLevel: eventual` for Graph's advanced queries). */
export interface ExplainTable {
  table: string;
  url: string;
  select: string[];
  filter: string | null;
  top: number | null;
  pushed: string[];
  local: LocalCondition[];
  perObject: string[];
  permissions: string[];
  docsUrl: string;
  orderBy: string | null;
  count: boolean;
  headers: string[];
  /** Columns a run would leave out, as the tenant is known to lack their license. */
  licenseLeftOut: LicenseLeftOut[];
  /** The license the table needs and the tenant lacks: a run stops before reading it. */
  missingLicense: string | null;
  missingLicenseSource: string | null;
  /** Relationship columns a run would read one object at a time. */
  relationships: ExplainRelationship[];
  /** The filter runs here, so every listed object's relationships are read. */
  filteredLocally: boolean;
}

export interface ExplainRelationship {
  column: string;
  url: string;
  permissions: string[];
  entryCap: number;
}

export interface ExplainLimits {
  objectsPerTable: number;
  fetchBudgetMb: number;
  perObjectReadsPerTable: number;
  relationshipObjectsPerTable: number;
  relationshipEntriesPerObject: number;
}

/** `query.explain`'s answer: the error (line and column are 0 for a parameter error, which has no position) or the refusal,
 * or the tables a run would fetch. */
export interface ExplainResult {
  error: { line: number; column: number; message: string } | null;
  refusal: string | null;
  tables: ExplainTable[];
  limits: ExplainLimits;
}

/** `raw.send`'s and `raw.next`'s answer. `truncated`: the body was cut off at the host's limit. `accountKey`: the account it
 * was sent for; `raw.next {nextLink, accountKey}` takes it back, so a next page goes out for the first page's account. */
export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  durationMs: number;
  nextLink: string | null;
  truncated: boolean;
  accountKey: string;
}

/** A permission `entraApp.plan` offers. `tables` is empty for a source permission, whose `unlocks` says what it opens instead.
 * Its identity is `resource + "|" + name`. */
export interface PlannedPermission {
  resource: string;
  resourceAppId: string;
  name: string;
  adminConsent: boolean;
  description: string;
  tables: string[];
  unlocks: string | null;
  ticked: boolean;
}

export interface PlannedSubgroup {
  title: string;
  permissions: PlannedPermission[];
}

export interface PlannedGroup {
  id: 'graph' | 'security' | 'azure';
  title: string;
  subgroups: PlannedSubgroup[];
}

/** `entraApp.plan`'s answer. With `canCreate` false, `reason` says why and the tenant fields are empty. */
export interface EntraAppPlan {
  canCreate: boolean;
  reason?: string;
  defaultName: string;
  tenantId: string;
  tenantName: string;
  groups: PlannedGroup[];
  tablesWithData: number;
  tablesWithoutData: number;
  writeOnlyTables: number;
}

/** `entraApp.create`'s and `entraApp.retryServicePrincipal`'s answer. */
export interface EntraAppCreateResult {
  appId: string;
  objectId: string;
  servicePrincipalId: string | null;
  tenantId: string;
  ownerAdded: boolean;
  ownerMessage: string | null;
  dropped: string[];
  servicePrincipalMessage: string | null;
  adminScopes: string[];
}

/** `entraApp.step`'s event data while `entraApp.create` runs. */
export type EntraAppStep = 'lookUp' | 'createApp' | 'addOwner' | 'createServicePrincipal';

/** `entraApp.consentStatus`' answer. */
export interface EntraAppConsentStatus {
  granted: string[];
  missing: string[];
}
