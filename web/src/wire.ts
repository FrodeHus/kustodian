/** The shapes the host sends over the bridge (camelCase, as its `BridgeJson` writes them). */

export type Source = 'graph' | 'hunting' | 'arg';

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
  /** The run's id; its `query.progress` events carry it too. */
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
