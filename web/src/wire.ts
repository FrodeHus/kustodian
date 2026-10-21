/** The shapes the host sends over the bridge (camelCase, as its `BridgeJson` writes them). */

/** `raw` is the raw Graph request tab (Task 12); it never runs KQL. */
export type Source = 'graph' | 'hunting' | 'arg' | 'raw';

export interface SchemaColumn {
  name: string;
  type: string;
  description: string;
  filterable: boolean;
  listable: boolean;
  complexType: string | null;
  collection: boolean;
}

export interface SchemaTable {
  name: string;
  /** The Graph collection relative to the version (`auditLogs/signIns` for `auditLogs_signIns`). */
  path: string;
  description: string;
  docsUrl: string;
  permissions: string[];
  columns: SchemaColumn[];
}

export interface SchemaField {
  name: string;
  type: string;
  collection: boolean;
  complexType?: string | null;
  description: string;
}

/** `schema.get`'s answer. `source` says where the schema came from. */
export interface SchemaView {
  source: string;
  generatedAt: string;
  tables: SchemaTable[];
  complexTypes: Record<string, SchemaField[]>;
}

/** `schema.listedByDefault`'s answer: for the active account, the columns Graph lists by default (without `$select`) for each
 * table read so far, by table name. A table not in it hasn't been read yet. */
export interface ListedByDefault {
  tables: Record<string, string[]>;
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
  | 'failed';

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
  /** Columns left out after Graph refused the list for a license or feature the tenant lacks; `unlicensedReason` is Graph's message. */
  unlicensed: string[];
  unlicensedReason: string | null;
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
 * and null (or left out) for other tabs. */
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
}

export interface ExplainLimits {
  objectsPerTable: number;
  fetchBudgetMb: number;
  perObjectReadsPerTable: number;
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
