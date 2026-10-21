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
});
