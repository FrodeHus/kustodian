import { describe, expect, it } from 'vitest';
import type { SchemaView } from '../wire';
import { toKustoSchema } from './kusto-schema';

const view: SchemaView = {
  source: 'graph',
  origin: 'builtIn',
  fallbackReason: null,
  generatedAt: '2026-10-21T05:38:29Z',
  functions: [],
  complexTypes: {},
  tables: [
    {
      name: 'applications',
      path: 'applications',
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
    const schema = toKustoSchema(view, 'graph');

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

  it('hunting_functions_become_kusto_functions', () => {
    const hunting: SchemaView = {
      source: 'hunting',
      origin: 'tenant',
      fallbackReason: null,
      generatedAt: '2026-10-21T05:38:29Z',
      complexTypes: {},
      tables: [
        {
          name: 'DeviceInfo',
          path: null,
          description: '',
          docsUrl: null,
          permissions: null,
          columns: [{ name: 'DeviceId', type: 'string', description: '', filterable: null, listable: null, complexType: null, collection: false }],
        },
      ],
      functions: [
        {
          name: 'FileProfile',
          description: 'Adds what Microsoft knows about each file.',
          parameters: [
            { name: 'SHA1', type: 'string' },
            { name: 'limit', type: 'long' },
          ],
        },
      ],
    };

    const schema = toKustoSchema(hunting, 'hunting');

    expect(schema.cluster.connectionString).toBe('https://hunting.kustodian.invalid');
    expect(schema.database?.name).toBe('hunting');
    expect(schema.database?.tables.map((t) => t.name)).toEqual(['DeviceInfo']);
    expect(schema.database?.functions).toEqual([
      {
        name: 'FileProfile',
        body: '{ }',
        docstring: 'Adds what Microsoft knows about each file.',
        inputParameters: [
          { name: 'SHA1', type: 'string', cslType: 'string' },
          { name: 'limit', type: 'long', cslType: 'long' },
        ],
      },
    ]);
  });

  it('arg_properties_and_tags_are_dynamic', () => {
    const column = (name: string, type: string) => ({ name, type, description: '', filterable: null, listable: null, complexType: null, collection: false });
    const arg: SchemaView = {
      source: 'arg',
      origin: 'builtIn',
      fallbackReason: null,
      generatedAt: '2026-10-21T00:00:00Z',
      complexTypes: {},
      functions: [],
      tables: [
        {
          name: 'Resources',
          path: null,
          description: '',
          docsUrl: null,
          permissions: null,
          columns: [column('name', 'string'), column('properties', 'object'), column('tags', 'string')],
        },
      ],
    };

    const schema = toKustoSchema(arg, 'arg');

    expect(schema.cluster.connectionString).toBe('https://arg.kustodian.invalid');
    expect(schema.database?.name).toBe('arg');
    expect(schema.database?.tables[0]?.columns.map((c) => [c.name, c.type])).toEqual([
      ['name', 'string'],
      ['properties', 'dynamic'],
      ['tags', 'dynamic'],
    ]);
  });
});
