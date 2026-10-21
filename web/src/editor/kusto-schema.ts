import type { Database, EngineSchema } from '@kusto/monaco-kusto';
import type { SchemaView } from '../wire';

/**
 * The Graph schema as monaco-kusto's language service takes it (`worker.setSchema`): one cluster with one database, `graph`,
 * that holds every table. Complex and collection columns are `dynamic`, as the engine loads them. The cluster's address never
 * shows and is never called; the language service only needs one.
 */
export function toKustoSchema(view: SchemaView): EngineSchema {
  const database: Database = {
    name: 'graph',
    majorVersion: 1,
    minorVersion: 0,
    functions: [],
    graphs: [],
    entityGroups: [],
    tables: view.tables.map((t) => ({
      name: t.name,
      entityType: 'Table',
      docstring: t.description || undefined,
      columns: t.columns.map((c) => ({
        name: c.name,
        type: c.complexType || c.collection ? 'dynamic' : c.type,
        docstring: c.description || undefined,
      })),
    })),
  };
  return { clusterType: 'Engine', cluster: { connectionString: 'https://graph.kustodian.invalid', databases: [database] }, database };
}
