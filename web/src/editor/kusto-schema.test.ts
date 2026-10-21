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
      area: 'Apps and permissions',
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
          area: null,
          description: '',
          docsUrl: null,
          permissions: null,
          columns: [{ name: 'DeviceId', type: 'string', description: '', filterable: null, listable: null, complexType: null, collection: false }],
        },
      ],
      functions: [
        {
          name: 'MySavedFunction',
          description: 'A function saved in the tenant.',
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
        name: 'MySavedFunction',
        body: '{ }',
        docstring: 'A function saved in the tenant.',
        inputParameters: [
          { name: 'SHA1', type: 'string', cslType: 'string' },
          { name: 'limit', type: 'long', cslType: 'long' },
        ],
      },
    ]);
  });

  it('invoke_style_hunting_functions_take_the_piped_table_and_return_their_columns', () => {
    const fn = (name: string, parameters: [string, string][]) => ({ name, description: '', parameters: parameters.map(([n, type]) => ({ name: n, type })) });
    const hunting: SchemaView = {
      source: 'hunting',
      origin: 'builtIn',
      fallbackReason: null,
      generatedAt: '2026-10-21T00:00:00Z',
      complexTypes: {},
      tables: [],
      functions: [
        fn('AssignedIPAddresses', [
          ['DeviceId', 'string'],
          ['Timestamp', 'datetime'],
        ]),
        fn('DeviceFromIP', [
          ['IP', 'string'],
          ['Timestamp', 'datetime'],
        ]),
        fn('FileProfile', [
          ['SHA1', 'string'],
          ['limit', 'long'],
        ]),
        fn('SeenBy', [['DeviceId', 'string']]),
      ],
    };

    const [assigned, fromIp, profile, seenBy] = toKustoSchema(hunting, 'hunting').database!.functions;

    // Called on its own: its own parameters, and a body with the columns Microsoft documents, so a later `project IPAddress` is known.
    expect(assigned?.inputParameters).toEqual([
      { name: 'DeviceId', type: 'string', cslType: 'string' },
      { name: 'Timestamp', type: 'datetime', cslType: 'datetime' },
    ]);
    expect(assigned?.body).toBe('{ datatable(Timestamp:datetime, IPAddress:string, IPType:string, NetworkAdapterType:int, ConnectedNetworks:int)[] }');

    // `| invoke F()`: the piped table first, then the documented arguments, each optional.
    expect(profile?.inputParameters).toEqual([
      { name: 'T', columns: [] },
      { name: 'SHA1', type: 'string', cslType: 'string', cslDefaultValue: '"SHA1"' },
      { name: 'limit', type: 'long', cslType: 'long', cslDefaultValue: '100' },
    ]);
    // FileProfile adds its columns to the rows.
    expect(profile?.body).toMatch(/^\{ T \| extend SHA1="", SHA256="", .*GlobalPrevalence=int\(null\), .*IsCertificateValid=bool\(null\), .*ProfileAvailability="" \}$/);
    expect(seenBy?.inputParameters).toEqual([
      { name: 'T', columns: [] },
      { name: 'DeviceId', type: 'string', cslType: 'string', cslDefaultValue: '"DeviceId"' },
    ]);
    expect(seenBy?.body).toBe('{ datatable(DeviceId:string)[] }');
    expect(fromIp?.inputParameters).toEqual([
      { name: 'T', columns: [] },
      { name: 'IP', type: 'string', cslType: 'string', cslDefaultValue: '"IP"' },
      { name: 'Timestamp', type: 'datetime', cslType: 'datetime', cslDefaultValue: 'datetime(null)' },
    ]);
    expect(fromIp?.body).toBe('{ datatable(IP:string, DeviceId:string)[] }');
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
          area: null,
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
