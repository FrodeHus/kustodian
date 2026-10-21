import { describe, expect, it } from 'vitest';
import type { SchemaView } from '../wire';
import { toKustoSchema } from './kusto-schema';

const view: SchemaView = {
  source: 'graph',
  generatedAt: '2026-10-21T05:38:29Z',
  complexTypes: {},
  tables: [
    {
      name: 'applications',
      description: 'App registrations.',
      docsUrl: '',
      permissions: ['Application.Read.All'],
      columns: [
        { name: 'appId', type: 'string', description: 'The app ID.', filterable: true, listable: true, complexType: null, collection: false },
        { name: 'createdDateTime', type: 'datetime', description: '', filterable: true, listable: true, complexType: null, collection: false },
        {
          name: 'passwordCredentials',
          type: 'dynamic',
          description: 'Secrets.',
          filterable: false,
          listable: true,
          complexType: 'microsoft.graph.passwordCredential',
          collection: true,
        },
        {
          name: 'onPremisesPublishing',
          type: 'microsoft.graph.onPremisesPublishing',
          description: 'App Proxy.',
          filterable: false,
          listable: false,
          complexType: 'microsoft.graph.onPremisesPublishing',
          collection: false,
        },
      ],
    },
  ],
};

describe('toKustoSchema', () => {
  // Pinned: the result is what monaco-kusto's worker.setSchema takes, an EngineSchema with the database in context.
  it('toKustoSchema_maps_tables_columns_and_types', () => {
    const schema = toKustoSchema(view);

    expect(schema.clusterType).toBe('Engine');
    expect(schema.cluster.databases).toHaveLength(1);
    expect(schema.database).toBe(schema.cluster.databases[0]);
    expect(schema.database?.name).toBe('graph');
    expect(schema.database?.tables).toEqual([
      {
        name: 'applications',
        entityType: 'Table',
        docstring: 'App registrations.',
        columns: [
          { name: 'appId', type: 'string', docstring: 'The app ID.' },
          { name: 'createdDateTime', type: 'datetime', docstring: undefined },
          { name: 'passwordCredentials', type: 'dynamic', docstring: 'Secrets.' },
          { name: 'onPremisesPublishing', type: 'dynamic', docstring: 'App Proxy.' },
        ],
      },
    ]);
  });
});
