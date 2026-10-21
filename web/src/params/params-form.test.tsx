import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTabs } from '../tabs/tab-store';
import type { LibraryList, SavedQuery } from '../wire';
import { ParamsForm } from './params-form';

const bridge = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call: bridge.call,
  on: () => () => undefined,
}));

const TEXT = 'applications\n| where ends < now() + {withinDays}\n| where signInAudience in ({audiences})';

const saved: SavedQuery = {
  version: 1,
  id: 'q1',
  name: 'Expiring',
  folder: 'Apps',
  source: 'graph',
  text: 'the text as saved',
  parameters: [],
  createdAt: '2026-10-01T00:00:00Z',
  modifiedAt: '2026-10-01T00:00:00Z',
};

beforeEach(() => {
  bridge.call.mockReset();
  bridge.call.mockImplementation((method: string, params?: { query?: SavedQuery }) =>
    Promise.resolve(method === 'library.list' ? ({ queries: [saved], folders: ['Apps'], skipped: 0 } satisfies LibraryList) : (params?.query ?? null)),
  );
  useTabs.setState({ tabs: [], activeId: null, cursors: {} });
});

const tab = () => useTabs.getState().tabs[0]!;

function ShowForm({ onRun }: { onRun: () => void }) {
  const current = useTabs((s) => s.tabs[0]);
  return current ? <ParamsForm tab={current} query={current.text} onRun={onRun} /> : null;
}

describe('ParamsForm', () => {
  it('params_form_shows_preview_and_runs', () => {
    useTabs.getState().openWith({
      source: 'graph',
      title: 'Q',
      text: TEXT,
      parameters: [{ name: 'withinDays', type: 'timespan', value: '30d', required: false, choices: ['7d', '30d', '90d'] }],
    });
    const onRun = vi.fn();
    render(<ShowForm onRun={onRun} />);

    const within1 = screen.getByRole('group', { name: 'withinDays' });
    // A parameter with choices picks among them.
    expect(within(within1).getByRole('combobox', { name: 'withinDays · timespan' })).toHaveProperty('value', '30d');
    expect(within(within1).getByRole('textbox', { name: 'Choices' })).toHaveProperty('value', '7d\n30d\n90d');

    // A new placeholder starts as text; make it a list.
    const audiences = screen.getByRole('group', { name: 'audiences' });
    fireEvent.change(within(audiences).getByRole('combobox', { name: 'Type' }), { target: { value: 'list' } });
    fireEvent.change(within(audiences).getByRole('textbox', { name: 'audiences · list' }), { target: { value: 'AzureADMyOrg\nAzureADMultipleOrgs' } });
    fireEvent.click(within(audiences).getByRole('checkbox', { name: 'Required' }));

    expect(screen.getByLabelText('The query as it will run').textContent).toBe(
      'applications\n| where ends < now() + 30d\n| where signInAudience in ("AzureADMyOrg", "AzureADMultipleOrgs")',
    );
    expect(tab().parameters).toEqual([
      { name: 'withinDays', type: 'timespan', value: '30d', required: false, choices: ['7d', '30d', '90d'] },
      { name: 'audiences', type: 'list', value: 'AzureADMyOrg\nAzureADMultipleOrgs', required: true, choices: null },
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Run with these values' }));
    expect(onRun).toHaveBeenCalledOnce();
  });

  it('params_form_remember_defaults_saves_with_the_query', async () => {
    useTabs.getState().openWith({ source: 'graph', title: 'Expiring', text: 'print {n}', savedId: 'q1' });
    render(<ShowForm onRun={() => undefined} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Type' }), { target: { value: 'number' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'n · number' }), { target: { value: '5' } });

    fireEvent.click(screen.getByRole('button', { name: 'Remember as defaults for this query' }));

    // Only the parameters change: the saved text, name and folder stay.
    await waitFor(() =>
      expect(bridge.call).toHaveBeenCalledWith('library.save', {
        query: expect.objectContaining({
          id: 'q1',
          name: 'Expiring',
          folder: 'Apps',
          text: 'the text as saved',
          parameters: [{ name: 'n', type: 'number', value: '5', required: false, choices: null }],
        }),
      }),
    );
    expect(await screen.findByText('Kept as this query’s defaults.')).toBeTruthy();
  });

  it('params_form_remember_needs_a_saved_query', () => {
    useTabs.getState().openWith({ source: 'graph', title: 'Q', text: 'print {n}' });
    render(<ShowForm onRun={() => undefined} />);
    const remember = screen.getByRole('button', { name: 'Remember as defaults for this query' });
    expect(remember).toHaveProperty('disabled', true);
    // Said on screen, not only in a tooltip.
    expect(screen.getByText('Save the query to the library first to keep defaults with it.')).toBeTruthy();
    expect(remember.getAttribute('aria-describedby')).toBe(screen.getByText('Save the query to the library first to keep defaults with it.').id);
  });
});
