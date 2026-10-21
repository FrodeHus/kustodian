import type { Database, EngineSchema } from '@kusto/monaco-kusto';
import type { SchemaSource } from '../schema/schema-store';
import type { SchemaColumn, SchemaView } from '../wire';

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
 * hunting's functions become functions with their parameters and descriptions; their bodies aren't known, so each has an empty
 * one (its result has no known columns). The cluster's address never shows and is never called; the language service only needs
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
    functions: (view?.functions ?? []).map((f) => ({
      name: f.name,
      body: '{ }',
      docstring: f.description || undefined,
      inputParameters: f.parameters.map((p) => ({ name: p.name, type: p.type, cslType: p.type })),
    })),
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
