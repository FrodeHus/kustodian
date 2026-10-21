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
    expect(screen.getAllByRole('button', { expanded: true }).map((b) => b.textContent)).toEqual([expect.stringContaining('applications')]);
  });

  const column = (name: string, type: string) => ({ name, type, description: '', filterable: null, listable: null, complexType: null, collection: false });

  it('schema_panel_shows_hunting_tables_and_functions', () => {
    const onInsert = vi.fn();
    const hunting: SchemaView = {
      source: 'hunting',
      origin: 'tenant',
      fallbackReason: null,
      generatedAt: '2026-10-21T00:00:00Z',
      complexTypes: {},
      tables: [{ name: 'DeviceInfo', path: null, description: 'Devices.', docsUrl: null, permissions: null, columns: [column('DeviceId', 'string')] }],
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
      tables: [{ name: 'Resources', path: null, description: '', docsUrl: null, permissions: null, columns: [column('name', 'string'), column('properties', 'dynamic')] }],
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
