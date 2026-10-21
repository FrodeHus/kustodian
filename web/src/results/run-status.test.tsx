import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTabs } from '../tabs/tab-store';
import type { RunResult, TableFetch } from '../wire';
import { RunStatus } from './run-status';

const call = vi.hoisted(() => vi.fn());
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call,
  on: () => () => undefined,
}));

const fetch: TableFetch = {
  table: 'applications',
  requests: ['applications?$select=displayName,onPremisesPublishing'],
  unfiltered: false,
  unreadable: [],
  denied: [],
  perObject: [],
  perObjectFailed: 0,
  perObjectCapped: false,
  perObjectCached: 0,
  unlicensed: [],
  unlicensedReason: null,
};

function result(overrides: Partial<RunResult>): RunResult {
  return {
    outcome: 'ok',
    message: null,
    error: null,
    columns: [{ name: 'displayName', type: 'string' }],
    rows: [['Contoso Portal']],
    total: 1,
    tables: [fetch],
    durationMs: 1800,
    droppedValues: 0,
    runId: 'run-1',
    diagnostics: [],
    ...overrides,
  };
}

const done = (r: RunResult) => ({ state: 'done' as const, runId: r.runId, result: r, startedAt: Date.parse('2026-10-21T09:41:12Z'), origin: { line: 1, column: 1 } });

beforeEach(() => {
  call.mockReset();
  useTabs.setState({ tabs: [], activeId: null, cursors: {} });
});

describe('RunStatus', () => {
  it('run_status_shows_denied_columns_chip_with_names', () => {
    render(<RunStatus run={done(result({ tables: [{ ...fetch, denied: ['onPremisesPublishing'] }] }))} onSignIn={() => undefined} />);

    expect(screen.getByText('onPremisesPublishing: no permission, values empty')).toBeTruthy();
    expect(screen.getByText('● 1 row')).toBeTruthy();
    expect(screen.getByText('1 Graph request')).toBeTruthy();
  });

  it('run_status_shows_unlicensed_columns_chip_with_names_and_graphs_reason', () => {
    const reason = "Neither tenant is B2C or tenant doesn't have premium license";
    render(<RunStatus run={done(result({ tables: [{ ...fetch, table: 'users', unlicensed: ['signInActivity', 'aboutMe'], unlicensedReason: reason }] }))} onSignIn={() => undefined} />);

    const chip = screen.getByText('signInActivity, aboutMe: left out, the tenant lacks a license, values empty');
    expect(chip.closest('[title]')?.getAttribute('title')).toBe(`users: ${reason}`);
  });

  it('status_line_shows_total_requests_and_cache', () => {
    const rows = Array.from({ length: 50000 }, (_, i) => [`app ${i}`]);
    const tables = [
      { ...fetch, requests: ['applications?$top=999', 'applications?$skiptoken=1'], perObjectCached: 5 },
      { ...fetch, table: 'servicePrincipals', requests: ['servicePrincipals?$top=999'], perObjectCached: 2 },
    ];
    render(<RunStatus run={done(result({ rows, total: 61204, tables, durationMs: 1800 }))} onSignIn={() => undefined} />);

    expect(screen.getByText('● 50,000 of 61,204 rows')).toBeTruthy();
    expect(screen.getByText('3 Graph requests')).toBeTruthy();
    expect(screen.getByText('7 objects from cache')).toBeTruthy();
    expect(screen.getByText(/· 1\.8 s$/)).toBeTruthy();
  });

  it('run_status_too_large_shows_message', () => {
    const message = 'The query would fetch more than 512 MB from Graph. Add a filter or take fewer columns.';
    render(<RunStatus run={done(result({ outcome: 'tooLarge', message, rows: [], columns: [], total: 0 }))} onSignIn={() => undefined} />);

    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.queryByText(/rows?$/)).toBeNull();
  });

  it('query_error_in_a_block_below_the_top_shows_the_editor_line', async () => {
    // The host counts lines within the block it was sent: line 2 of the block that starts on line 4.
    const error = { line: 2, column: 3, message: "'wher' isn't an operator." };
    call.mockResolvedValue(result({ outcome: 'queryError', message: error.message, error, rows: [], columns: [], total: 0, tables: [] }));
    const id = useTabs.getState().open('graph');
    useTabs.getState().setText(id, 'applications\n| take 1\n\nusers\n| wher x\n| count');
    useTabs.getState().setCursor(id, { line: 6, column: 1, selection: '', selectionLine: 6, selectionColumn: 1 });
    await useTabs.getState().run(id, 'block');

    render(<RunStatus run={useTabs.getState().tabs[0]?.run} onSignIn={() => undefined} />);
    expect(screen.getByText('Ln 5, Col 3')).toBeTruthy();
  });

  it('query_error_on_the_first_line_of_a_selection_moves_the_column', async () => {
    const error = { line: 1, column: 4, message: 'Bad.' };
    call.mockResolvedValue(result({ outcome: 'queryError', message: error.message, error, rows: [], columns: [], total: 0, tables: [] }));
    const id = useTabs.getState().open('graph');
    useTabs.getState().setText(id, 'let x = 1;\nusers | wher y');
    // "wher y" is selected from line 2, column 9; the host's column 4 is the editor's column 12.
    useTabs.getState().setCursor(id, { line: 2, column: 15, selection: 'wher y', selectionLine: 2, selectionColumn: 9 });
    await useTabs.getState().run(id, 'selection');

    render(<RunStatus run={useTabs.getState().tabs[0]?.run} onSignIn={() => undefined} />);
    expect(screen.getByText('Ln 2, Col 12')).toBeTruthy();
  });

  it('run_status_sign_in_needed_shows_sign_in_button_and_keeps_text', async () => {
    const message = 'Sign in again to run this query.';
    call.mockResolvedValue(result({ outcome: 'signInNeeded', message, rows: [], columns: [], total: 0, tables: [] }));
    const id = useTabs.getState().open('graph');
    useTabs.getState().setText(id, 'applications | take 5');
    await useTabs.getState().run(id, 'all');
    const onSignIn = vi.fn();

    render(<RunStatus run={useTabs.getState().tabs[0]?.run} onSignIn={onSignIn} />);
    expect(screen.getByText(message)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(onSignIn).toHaveBeenCalledOnce();
    // The query is still there to run again once signed in.
    expect(useTabs.getState().tabs[0]).toMatchObject({ text: 'applications | take 5', dirty: true });
  });
});
