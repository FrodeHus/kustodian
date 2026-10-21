import type { Database, EngineSchema, Function as KustoFunction, InputParameter } from '@kusto/monaco-kusto';
import type { SchemaSource } from '../schema/schema-store';
import type { SchemaColumn, SchemaFunction, SchemaView } from '../wire';

/** What Microsoft documents about advanced hunting's built-in functions that `getHuntingSchema` doesn't say: whether it is called
 * with `| invoke` (the rows piped in are its first, tabular argument), the defaults of its optional arguments, and the columns it
 * returns (or, with `extends`, adds to the rows piped in). Sources: learn.microsoft.com/defender-xdr/advanced-hunting-
 * assignedipaddresses-function, -devicefromip-function, -fileprofile-function and -seenby-function (read 2026-10-21). */
interface KnownFunction {
  invoke: boolean;
  defaults?: Record<string, string>;
  columns: [string, string][];
  extends?: boolean;
}

const HUNTING_FUNCTIONS: Record<string, KnownFunction> = {
  AssignedIPAddresses: {
    invoke: false,
    columns: [
      ['Timestamp', 'datetime'],
      ['IPAddress', 'string'],
      ['IPType', 'string'],
      ['NetworkAdapterType', 'int'],
      ['ConnectedNetworks', 'int'],
    ],
  },
  DeviceFromIP: {
    invoke: true,
    defaults: { IP: '"IP"' },
    columns: [
      ['IP', 'string'],
      ['DeviceId', 'string'],
    ],
  },
  FileProfile: {
    invoke: true,
    extends: true,
    defaults: { SHA1: '"SHA1"', limit: '100' },
    columns: [
      ['SHA1', 'string'],
      ['SHA256', 'string'],
      ['MD5', 'string'],
      ['FileSize', 'int'],
      ['GlobalPrevalence', 'int'],
      ['GlobalFirstSeen', 'datetime'],
      ['GlobalLastSeen', 'datetime'],
      ['Signer', 'string'],
      ['Issuer', 'string'],
      ['SignerHash', 'string'],
      ['IsCertificateValid', 'bool'],
      ['IsRootSignerMicrosoft', 'bool'],
      ['SignatureState', 'string'],
      ['IsExecutable', 'bool'],
      ['ThreatName', 'string'],
      ['Publisher', 'string'],
      ['SoftwareName', 'string'],
      ['ProfileAvailability', 'string'],
    ],
  },
  SeenBy: { invoke: true, defaults: { DeviceId: '"DeviceId"' }, columns: [['DeviceId', 'string']] },
};

/** A typed empty value for a function body's columns: KQL has no null string. */
const emptyOf = (type: string) => (type === 'string' ? '""' : `${type}(null)`);

/** An optional argument's default when Microsoft documents none. */
const defaultOf = (type: string) => (type === 'string' ? '""' : type === 'datetime' || type === 'timespan' ? `${type}(null)` : '0');

/** A hunting function as monaco-kusto takes it. A built-in one Microsoft documents gets the piped table as its first parameter
 * when it is called with `| invoke` (its other arguments optional), and a body that returns its documented columns, so the
 * columns after it are known. Any other (a tenant's saved function) gets its parameters and an empty body. */
function toKustoFunction(f: SchemaFunction): KustoFunction {
  const known = Object.hasOwn(HUNTING_FUNCTIONS, f.name) ? HUNTING_FUNCTIONS[f.name] : undefined;
  const scalars: InputParameter[] = f.parameters.map((p) =>
    known?.invoke
      ? { name: p.name, type: p.type, cslType: p.type, cslDefaultValue: known.defaults?.[p.name] ?? defaultOf(p.type) }
      : { name: p.name, type: p.type, cslType: p.type },
  );
  let body = '{ }';
  if (known?.extends) {
    body = `{ T | extend ${known.columns.map(([name, type]) => `${name}=${emptyOf(type)}`).join(', ')} }`;
  } else if (known) {
    body = `{ datatable(${known.columns.map(([name, type]) => `${name}:${type}`).join(', ')})[] }`;
  }
  return {
    name: f.name,
    body,
    docstring: f.description || undefined,
    inputParameters: known?.invoke ? [{ name: 'T', columns: [] }, ...scalars] : scalars,
  };
}

/** Resource Graph columns that hold objects, whatever type the table list gives them. */
const ARG_DYNAMIC = new Set(['properties', 'tags']);

function columnType(c: SchemaColumn, source: SchemaSource): string {
  if (c.complexType || c.collection || (source === 'arg' && ARG_DYNAMIC.has(c.name))) {
    return 'dynamic';
  }
  return c.type;
}

/**
 * A source's schema as monaco-kusto's language service takes it (`worker.setSchema`): one cluster,
 * `https://{source}.kustodian.invalid`, with one database named after the source that holds every table. Graph's complex and
 * collection columns are `dynamic`, as the engine loads them, and so are Resource Graph's `properties` and `tags`. Advanced
 * hunting's functions become functions with their parameters and descriptions ({@link toKustoFunction}). The cluster's address never shows and is never called; the language service only needs
 * one. Without a view the database is empty.
 *
 * monaco-kusto keeps each database it was given by cluster and name, and takes a new one only when its `majorVersion` is higher,
 * so `version` must grow whenever the content for a source changes (read after an empty one, refreshed, another account's).
 */
export function toKustoSchema(view: SchemaView | undefined, source: SchemaSource, version = 1): EngineSchema {
  const database: Database = {
    name: source,
    majorVersion: version,
    minorVersion: 0,
    functions: (view?.functions ?? []).map(toKustoFunction),
    graphs: [],
    entityGroups: [],
    tables: (view?.tables ?? []).map((t) => ({
      name: t.name,
      entityType: 'Table',
      docstring: t.description || undefined,
      columns: t.columns.map((c) => ({
        name: c.name,
        type: columnType(c, source),
        docstring: c.description || undefined,
      })),
    })),
  };
  return { clusterType: 'Engine', cluster: { connectionString: `https://${source}.kustodian.invalid`, databases: [database] }, database };
}
