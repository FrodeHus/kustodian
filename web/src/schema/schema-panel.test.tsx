import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import schema from '../fixtures/graph-schema.json';
import type { SchemaView } from '../wire';
import { SchemaPanel } from './schema-panel';

const view = schema as SchemaView;

describe('SchemaPanel', () => {
  it('schema_panel_shows_tables_in_the_query_with_column_tags_and_descriptions', () => {
    render(<SchemaPanel schema={view} text="applications | take 5" onInsert={() => undefined} />);

    expect(screen.getByRole('searchbox', { name: 'Find a table or column' })).toHaveProperty('placeholder', `Find among ${view.tables.length} tables`);
    const appId = screen.getByRole('button', { name: /^appId/ });
    expect(within(appId).getByText('filter')).toBeTruthy();
    expect(within(appId).getByText('string')).toBeTruthy();
    expect(appId.title).toMatch(/^appId: The unique identifier for the application/);
    expect(within(screen.getByRole('button', { name: /^identifierUris/ })).getByText('dynamic[]')).toBeTruthy();
  });

  it('schema_panel_search_opens_tables_on_matching_columns_and_inserts_names', () => {
    const onInsert = vi.fn();
    render(<SchemaPanel schema={view} text="" onInsert={onInsert} />);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a table or column' }), { target: { value: 'onPremisesPub' } });
    const column = screen.getByRole('button', { name: /^onPremisesPublishing/ });
    fireEvent.click(column);

    expect(onInsert).toHaveBeenCalledWith('onPremisesPublishing');
    // The match keeps its area, opened.
    expect(screen.getAllByRole('button', { expanded: true }).map((b) => b.textContent)).toEqual([
      expect.stringContaining('Apps and permissions'),
      expect.stringContaining('applications'),
    ]);
  });

  const column = (name: string, type: string) => ({ name, type, description: '', filterable: null, listable: null, complexType: null, collection: false });

  /** A Graph table as `SchemaView.From` writes it: the name is the path with `/` as `_`, and the host gives its area. */
  const graphTable = (path: string, area: string) => ({
    name: path.replaceAll('/', '_'),
    path,
    area,
    description: '',
    docsUrl: null,
    permissions: [],
    columns: [column('id', 'string')],
  });

  const graph: SchemaView = {
    ...view,
    // Schema order is by name, as the host sends it; the panel orders the areas itself.
    tables: [
      graphTable('auditLogs/signIns', 'Sign-in and audit logs'),
      graphTable('authenticationMethodDevices', 'Devices and Intune'),
      graphTable('copilot/conversations', 'Other'),
      graphTable('deviceAppManagement/mobileApps', 'Devices and Intune'),
      graphTable('deviceManagement/deviceCompliancePolicies', 'Devices and Intune'),
      graphTable('deviceManagement/managedDevices', 'Devices and Intune'),
      graphTable('devices', 'Devices and Intune'),
      graphTable('security/alerts_v2', 'Security'),
      graphTable('users', 'Users, groups and directory'),
    ],
  };

  const allTables = () => screen.getByRole('list', { name: 'All tables' });
  /** The rows directly in a list: its areas, subgroups or tables, not what they hold. */
  const rows = (list: HTMLElement) => [...list.children].map((li) => li.querySelector('button')?.textContent);

  it('schema_panel_groups_graph_tables_by_area_in_order_with_counts', () => {
    render(<SchemaPanel schema={graph} text="" onInsert={() => undefined} />);

    // Closed by default, in the fixed order, with counts; areas without tables don't show.
    expect(rows(allTables())).toEqual([
      '▸Users, groups and directory1',
      '▸Sign-in and audit logs1',
      '▸Devices and Intune5',
      '▸Security1',
      '▸Other1',
    ]);
    expect(screen.queryByRole('button', { name: /^users/ })).toBeNull();
  });

  it('schema_panel_splits_devices_and_intune_by_first_path_segment', () => {
    render(<SchemaPanel schema={graph} text="" onInsert={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: /Devices and Intune/ }));
    const subgroups = screen.getByRole('list', { name: 'Devices and Intune' });
    expect(rows(subgroups)).toEqual(['▸deviceManagement2', '▸deviceAppManagement1', '▸Top level2']);

    fireEvent.click(within(subgroups).getByRole('button', { name: /^Top level/ }));
    expect(rows(screen.getByRole('list', { name: 'Top level' }))).toEqual([
      expect.stringMatching(/^▸authenticationMethodDevices/),
      expect.stringMatching(/^▸devices/),
    ]);
  });

  it('schema_panel_nested_table_shows_its_graph_path_and_keeps_its_behaviour', () => {
    const onInsert = vi.fn();
    render(<SchemaPanel schema={graph} text="" onInsert={onInsert} />);

    fireEvent.click(screen.getByRole('button', { name: /Sign-in and audit logs/ }));
    const signIns = screen.getByRole('button', { name: /auditLogs_signIns/ });
    expect(within(signIns).getByText('auditLogs/signIns')).toBeTruthy();
    expect(signIns.title).toBe('auditLogs_signIns (auditLogs/signIns)');
    fireEvent.doubleClick(signIns);
    expect(onInsert).toHaveBeenCalledWith('auditLogs_signIns');
    fireEvent.click(signIns);
    expect(screen.getByRole('button', { name: /^id/ })).toBeTruthy();

    // A top-level collection's path is its name: not repeated.
    fireEvent.click(screen.getByRole('button', { name: /Users, groups and directory/ }));
    expect(screen.getByRole('button', { name: /^users/ }).textContent).toBe('▸users1 columns');
  });

  it('schema_panel_search_keeps_the_grouping_and_opens_matching_areas', () => {
    render(<SchemaPanel schema={graph} text="" onInsert={() => undefined} />);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a table or column' }), { target: { value: 'managedDev' } });

    expect(rows(screen.getByRole('list', { name: 'Matches' }))).toEqual(['▾Devices and Intune1']);
    expect(rows(screen.getByRole('list', { name: 'Devices and Intune' }))).toEqual(['▾deviceManagement1']);
    expect(rows(screen.getByRole('list', { name: 'deviceManagement' }))).toEqual([expect.stringMatching(/^▸deviceManagement_managedDevices/)]);
  });

  it('schema_panel_in_this_query_stays_flat', () => {
    render(<SchemaPanel schema={graph} text="users | join (auditLogs_signIns) on id" onInsert={() => undefined} />);

    expect(rows(screen.getByRole('list', { name: 'In this query' }))).toEqual([
      expect.stringMatching(/^▾auditLogs_signIns/),
      expect.stringMatching(/^▾users/),
    ]);
  });

  it('schema_panel_keeps_hunting_and_arg_tables_flat', () => {
    const arg: SchemaView = {
      source: 'arg',
      origin: 'builtIn',
      fallbackReason: null,
      generatedAt: '2026-10-21T00:00:00Z',
      complexTypes: {},
      functions: [],
      tables: [
        { name: 'Resources', path: null, area: null, description: '', docsUrl: null, permissions: null, columns: [column('name', 'string')] },
        { name: 'ResourceContainers', path: null, area: null, description: '', docsUrl: null, permissions: null, columns: [column('name', 'string')] },
      ],
    };
    render(<SchemaPanel source="arg" schema={arg} text="" resourceTypes={[]} onInsert={() => undefined} />);

    expect(rows(allTables())).toEqual(['▸Resources1 columns', '▸ResourceContainers1 columns']);
  });

  it('schema_panel_shows_hunting_tables_and_functions', () => {
    const onInsert = vi.fn();
    const hunting: SchemaView = {
      source: 'hunting',
      origin: 'tenant',
      fallbackReason: null,
      generatedAt: '2026-10-21T00:00:00Z',
      complexTypes: {},
      tables: [{ name: 'DeviceInfo', path: null, area: null, description: 'Devices.', docsUrl: null, permissions: null, columns: [column('DeviceId', 'string')] }],
      functions: [{ name: 'FileProfile', description: 'What Microsoft knows about a file.', parameters: [{ name: 'SHA1', type: 'string' }, { name: 'limit', type: 'long' }] }],
    };
    render(<SchemaPanel source="hunting" schema={hunting} text="DeviceInfo" onInsert={onInsert} />);

    expect(screen.getByRole('complementary', { name: 'Advanced hunting schema' })).toBeTruthy();
    // Graph's column tags never show for another source's columns.
    const deviceId = screen.getByRole('button', { name: /^DeviceId/ });
    expect(within(deviceId).queryByText('per object')).toBeNull();
    expect(within(deviceId).queryByText('filter')).toBeNull();

    const fn = screen.getByRole('button', { name: /^FileProfile/ });
    expect(fn.textContent).toContain('(SHA1, limit)');
    expect(fn.title).toBe('FileProfile(SHA1: string, limit: long): What Microsoft knows about a file.');
    fireEvent.click(fn);
    expect(onInsert).toHaveBeenCalledWith('FileProfile');
  });

  it('schema_panel_shows_arg_tables_and_resource_types', () => {
    const onInsert = vi.fn();
    const arg: SchemaView = {
      source: 'arg',
      origin: 'builtIn',
      fallbackReason: null,
      generatedAt: '2026-10-21T00:00:00Z',
      complexTypes: {},
      functions: [],
      tables: [{ name: 'Resources', path: null, area: null, description: '', docsUrl: null, permissions: null, columns: [column('name', 'string'), column('properties', 'dynamic')] }],
    };
    const types = ['microsoft.compute/virtualmachines', 'microsoft.storage/storageaccounts'];
    const view = render(<SchemaPanel source="arg" schema={arg} text="" resourceTypes={types} onInsert={onInsert} />);

    expect(screen.getByRole('complementary', { name: 'Resource Graph tables' })).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Resource types' });
    expect(within(list).getAllByRole('button').map((b) => b.textContent)).toEqual(types);

    // A search finds resource types too.
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a table or column' }), { target: { value: 'storage' } });
    const found = screen.getByRole('list', { name: 'Resource types' });
    expect(within(found).getAllByRole('button').map((b) => b.textContent)).toEqual(['microsoft.storage/storageaccounts']);
    fireEvent.click(within(found).getByRole('button'));
    expect(onInsert).toHaveBeenCalledWith('"microsoft.storage/storageaccounts"');

    // When they can't be listed, it says why.
    view.rerender(<SchemaPanel source="arg" schema={arg} text="" resourceTypesError="Grant Azure access to list your resource types." onInsert={onInsert} />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a table or column' }), { target: { value: '' } });
    expect(screen.getByText('Grant Azure access to list your resource types.')).toBeTruthy();
  });

  it('schema_panel_says_when_the_schema_could_not_be_read', () => {
    render(<SchemaPanel source="hunting" schema={undefined} error="Graph is down." text="" onInsert={() => undefined} />);
    expect(screen.getByRole('alert').textContent).toBe('The schema couldn’t be loaded: Graph is down.');
  });
});
