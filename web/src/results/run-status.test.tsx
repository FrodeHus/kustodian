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
    ...overrides,
  };
}

const done = (r: RunResult) => ({ state: 'done' as const, result: r, startedAt: Date.parse('2026-10-21T09:41:12Z') });

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

  it('run_status_too_large_shows_message', () => {
    const message = 'The query would fetch more than 512 MB from Graph. Add a filter or take fewer columns.';
    render(<RunStatus run={done(result({ outcome: 'tooLarge', message, rows: [], columns: [], total: 0 }))} onSignIn={() => undefined} />);

    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.queryByText(/rows?$/)).toBeNull();
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
