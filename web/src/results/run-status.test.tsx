import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeError } from '../bridge';
import { useTabs } from '../tabs/tab-store';
import type { AccountInfo, RelationshipFetch, RunResult, TableFetch } from '../wire';
import { RunStatus } from './run-status';

const call = vi.hoisted(() => vi.fn());
const runCommand = vi.hoisted(() => vi.fn());
vi.mock('../shell/commands', () => ({ runCommand }));
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
  relationships: [],
  unlicensed: [],
  unlicensedReason: null,
  licenseLeftOut: [],
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
    permissions: [],
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

  it('run_status_names_columns_left_out_for_a_license_and_the_license', () => {
    const left = [{ column: 'signInActivity', license: 'Microsoft Entra ID P1 or P2', source: 'https://learn.microsoft.com/a' }];
    render(<RunStatus run={done(result({ tables: [{ ...fetch, table: 'users', licenseLeftOut: left }] }))} onSignIn={() => undefined} />);

    const chip = screen.getByText("signInActivity: left out, the tenant doesn't have Microsoft Entra ID P1 or P2, values empty");
    expect(chip.closest('[title]')?.getAttribute('title')).toBe('users.signInActivity needs Microsoft Entra ID P1 or P2: https://learn.microsoft.com/a');
  });

  it('run_status_shows_a_run_stopped_for_a_missing_license', () => {
    const message = "auditLogs_signIns needs Microsoft Entra ID P1 or P2, which the tenant doesn't have, so it wasn't read.";
    render(<RunStatus run={done(result({ outcome: 'unlicensed', message, rows: [], total: 0, tables: [] }))} onSignIn={() => undefined} />);

    expect(screen.getByText(message)).toBeTruthy();
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

  it('status_wording_follows_source', () => {
    const request = (detail: string) => ({ atMs: 0, kind: 'request' as const, detail, status: 200, durationMs: 900, bytes: 4096 });
    const retry = { atMs: 950, kind: 'retry' as const, detail: 'Sending the page again after 2 s', status: null, durationMs: null, bytes: null };

    // Graph: its requests.
    const view = render(<RunStatus run={done(result({}))} onSignIn={() => undefined} />);
    expect(screen.getByText('1 Graph request')).toBeTruthy();

    // Advanced hunting: one hunting query, and never "Graph requests".
    const hunting = result({ tables: [], diagnostics: [request('POST security/runHuntingQuery')] });
    view.rerender(<RunStatus run={{ ...done(hunting), source: 'hunting' }} onSignIn={() => undefined} />);
    expect(screen.getByText('1 hunting query')).toBeTruthy();
    expect(screen.queryByText(/Graph request/)).toBeNull();

    // Resource Graph: its pages (a page sent again counts once) and the scope.
    const arg = result({
      tables: [],
      diagnostics: [request('POST providers/Microsoft.ResourceGraph/resources'), retry, request('POST providers/Microsoft.ResourceGraph/resources'), request('POST providers/Microsoft.ResourceGraph/resources')],
    });
    view.rerender(<RunStatus run={{ ...done(arg), source: 'arg' }} onSignIn={() => undefined} />);
    expect(screen.getByText('2 pages · all I can see')).toBeTruthy();
    expect(screen.queryByText(/Graph request/)).toBeNull();
    view.rerender(<RunStatus run={{ ...done(arg), source: 'arg' }} scope={{ kind: 'subscriptions', ids: ['a', 'b', 'c'] }} onSignIn={() => undefined} />);
    expect(screen.getByText('2 pages · 3 subscriptions')).toBeTruthy();
    view.rerender(<RunStatus run={{ ...done(arg), source: 'arg' }} scope={{ kind: 'managementGroup', ids: ['contoso-platform'] }} onSignIn={() => undefined} />);
    expect(screen.getByText('2 pages · contoso-platform')).toBeTruthy();
  });

  it('run_status_shows_an_ok_runs_note', () => {
    const truncated = result({ tables: [], total: 3, rows: [['a'], ['b'], ['c']], message: 'Resource Graph cut this result short; include the id column to page through all rows.' });

    render(<RunStatus run={{ ...done(truncated), source: 'arg' }} onSignIn={() => undefined} />);

    const note = screen.getByText('Resource Graph cut this result short; include the id column to page through all rows.');
    expect(note.className).toContain('warn');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('consent_button_grants_and_reruns', async () => {
    const message = 'Azure Resource Graph needs your consent to read Azure for this account.';
    call.mockImplementation((method: string) =>
      Promise.resolve(
        method === 'query.run'
          ? call.mock.calls.filter((c) => c[0] === 'query.run').length === 1
            ? result({ outcome: 'consentNeeded', message, rows: [], columns: [], total: 0, tables: [] })
            : result({ tables: [] })
          : {},
      ),
    );
    const id = useTabs.getState().open('arg');
    useTabs.getState().setText(id, 'Resources | take 5');
    await useTabs.getState().run(id, 'all');

    const Status = () => <RunStatus run={useTabs((s) => s.tabs[0]?.run)} accountKey="k1" onConsented={() => void useTabs.getState().rerun(id)} onSignIn={() => undefined} />;
    render(<Status />);
    expect(screen.getByText(message)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Grant Azure access' }));

    await screen.findByText('● 1 row');
    expect(call).toHaveBeenCalledWith('account.consent', { key: 'k1', audience: 'arm' });
    expect(call.mock.calls.filter((c) => c[0] === 'query.run')).toHaveLength(2);
  });

  it('consent_does_not_rerun_a_tab_whose_source_changed', async () => {
    call.mockImplementation((method: string) =>
      Promise.resolve(method === 'query.run' ? result({ outcome: 'consentNeeded', message: 'Grant access.', rows: [], columns: [], total: 0, tables: [] }) : {}),
    );
    const id = useTabs.getState().open('arg');
    useTabs.getState().setText(id, 'Resources | take 5');
    await useTabs.getState().run(id, 'all');
    // Ruling 6: the Resource Graph query must never go to Graph; access is still granted.
    useTabs.getState().setSource(id, 'graph');

    render(<RunStatus run={useTabs.getState().tabs[0]?.run} accountKey="k1" onConsented={() => void useTabs.getState().rerun(id)} onSignIn={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Grant Azure access' }));

    await waitFor(() => expect(call).toHaveBeenCalledWith('account.consent', { key: 'k1', audience: 'arm' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(call.mock.calls.filter((c) => c[0] === 'query.run')).toHaveLength(1);
    expect(useTabs.getState().tabs[0]?.run?.source).toBe('arg');
  });

  it('consent_cancelled_is_quiet_and_another_account_is_an_error', async () => {
    const consentNeeded = done(result({ outcome: 'consentNeeded', message: 'Grant access.', rows: [], columns: [], total: 0, tables: [] }));
    const onConsented = vi.fn();
    call.mockRejectedValueOnce(new BridgeError('cancelled', 'The request was cancelled.'));
    render(<RunStatus run={{ ...consentNeeded, source: 'arg' }} accountKey="k1" onConsented={onConsented} onSignIn={() => undefined} />);
    const grant = screen.getByRole('button', { name: 'Grant Azure access' });

    fireEvent.click(grant);
    await waitFor(() => expect((grant as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText('The request was cancelled.')).toBeNull();

    const other = 'You granted access as ola@contoso.com; sign in as kari@contoso.com.';
    call.mockRejectedValueOnce(new BridgeError('failed', other));
    fireEvent.click(grant);
    expect(await screen.findByText(other)).toBeTruthy();
    expect(onConsented).not.toHaveBeenCalled();
  });

  it('noPermission_shows_create_button_for_azure_cli_only', () => {
    const run = done(result({ outcome: 'noPermission', message: 'No permission.' }));
    const { unmount } = render(<RunStatus run={run} onSignIn={() => undefined} createApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Create Entra ID application…' }));
    expect(runCommand).toHaveBeenCalledWith('account.createEntraApp');
    unmount();
    const second = render(<RunStatus run={run} onSignIn={() => undefined} />);
    expect(screen.queryByRole('button', { name: 'Create Entra ID application…' })).toBeNull();
    second.unmount();
    render(<RunStatus run={done(result({}))} onSignIn={() => undefined} createApp />);
    expect(screen.queryByRole('button', { name: 'Create Entra ID application…' })).toBeNull();
  });

  describe('grant permission', () => {
    const account = (clientKind: AccountInfo['clientKind'], scopes: string[] = []): AccountInfo => ({
      key: 'k1',
      username: 'ola@contoso.com',
      tenantName: 'Contoso',
      tenantId: 't1',
      clientId: 'c1',
      clientKind,
      active: true,
      expired: false,
      scopes,
    });
    const refused = (permissions: string[]) => done(result({ outcome: 'noPermission', message: 'No permission.', permissions }));

    it('no_permission_for_graph_cli_shows_grant_permission_and_reruns_after_consent', async () => {
      call.mockResolvedValueOnce({});
      const onConsented = vi.fn();
      render(<RunStatus run={refused(['Reports.Read.All'])} account={account('graphCli')} accountKey="k1" onConsented={onConsented} onSignIn={() => undefined} />);
      const grant = screen.getByRole('button', { name: /^Grant permission/ });
      expect(grant.getAttribute('title')).toBe('Reports.Read.All');
      fireEvent.click(grant);
      await waitFor(() => expect(onConsented).toHaveBeenCalledTimes(1));
      expect(call).toHaveBeenCalledWith('account.consent', { key: 'k1', audience: 'graph', scope: 'Reports.Read.All' });
    });

    it('grant_permission_refused_shows_not_granted_note', async () => {
      call.mockRejectedValueOnce(new BridgeError('cancelled', 'The request was cancelled.'));
      const onConsented = vi.fn();
      render(<RunStatus run={refused(['Reports.Read.All'])} account={account('own')} accountKey="k1" onConsented={onConsented} onSignIn={() => undefined} />);
      fireEvent.click(screen.getByRole('button', { name: /^Grant permission/ }));
      expect(await screen.findByText('Not granted. An administrator has to grant Reports.Read.All.')).toBeTruthy();
      expect(onConsented).not.toHaveBeenCalled();
    });

    it('no_permission_for_azure_cli_shows_no_grant_permission', () => {
      render(<RunStatus run={refused(['Reports.Read.All'])} account={account('azureCli')} accountKey="k1" onSignIn={() => undefined} />);
      expect(screen.queryByRole('button', { name: /^Grant permission/ })).toBeNull();
    });

    it('no_permission_with_the_permission_held_shows_the_role_note', () => {
      render(<RunStatus run={refused(['Reports.Read.All'])} account={account('graphCli', ['reports.read.all'])} accountKey="k1" onSignIn={() => undefined} />);
      expect(screen.queryByRole('button', { name: /^Grant permission/ })).toBeNull();
      expect(screen.getByText('You have Reports.Read.All; your account may be missing a role that this data needs.')).toBeTruthy();
    });

    it('refused_relationship_column_offers_grant_permission', () => {
      const relationship: RelationshipFetch = {
        column: 'memberOf',
        objects: 40,
        truncated: 0,
        entryCap: 1000,
        refused: 40,
        permissions: ['GroupMember.Read.All', 'Directory.Read.All'],
        capped: false,
        filteredLocally: false,
        limited: 0,
      };
      const run = done(result({ tables: [{ ...fetch, table: 'users', relationships: [relationship, { ...relationship, column: 'ownedObjects' }] }] }));
      render(<RunStatus run={run} account={account('graphCli')} accountKey="k1" onSignIn={() => undefined} />);
      const buttons = screen.getAllByRole('button', { name: /^Grant permission/ });
      expect(buttons).toHaveLength(1);
      expect(buttons[0]?.getAttribute('title')).toBe('GroupMember.Read.All');
      expect(buttons[0]?.getAttribute('aria-label')).toBe('Grant permission GroupMember.Read.All');
    });

    it('partly_refused_relationship_column_offers_no_grant_permission', () => {
      const relationship: RelationshipFetch = {
        column: 'memberOf',
        objects: 40,
        truncated: 0,
        entryCap: 1000,
        refused: 3,
        permissions: ['GroupMember.Read.All'],
        capped: false,
        filteredLocally: false,
        limited: 0,
      };
      const run = done(result({ tables: [{ ...fetch, table: 'users', relationships: [relationship] }] }));
      render(<RunStatus run={run} account={account('graphCli')} accountKey="k1" onSignIn={() => undefined} />);
      expect(screen.queryByRole('button', { name: /^Grant permission/ })).toBeNull();
    });
  });

  describe('relationship chips', () => {
    const rel = (o: Partial<RelationshipFetch>): RelationshipFetch => ({
      column: 'memberOf',
      objects: 40,
      truncated: 0,
      entryCap: 1000,
      refused: 0,
      permissions: ['GroupMember.Read.All', 'Directory.Read.All'],
      capped: false,
      filteredLocally: false,
      limited: 0,
      ...o,
    });
    const show = (table: string, relationships: RelationshipFetch[], extra: Partial<TableFetch> = {}) =>
      render(<RunStatus run={done(result({ tables: [{ ...fetch, table, relationships, ...extra }] }))} onSignIn={() => undefined} />);

    it('shows_truncated_entries', () => {
      show('groups', [rel({ column: 'members', truncated: 2 })]);
      expect(screen.getByText('groups.members: cut off at 1,000 entries for 2 objects')).toBeTruthy();
    });

    it('shows_all_refused', () => {
      show('users', [rel({ refused: 40 })]);
      expect(screen.getByText('No permission to read users.memberOf; it needs one of: GroupMember.Read.All, Directory.Read.All')).toBeTruthy();
    });

    it('shows_all_refused_without_permissions_to_name', () => {
      show('users', [rel({ refused: 40, permissions: [] })]);
      expect(screen.getByText('No permission to read users.memberOf')).toBeTruthy();
      expect(screen.queryByText(/needs one of/)).toBeNull();
    });

    it('shows_limited_entries', () => {
      show('users', [rel({ limited: 3 })]);
      expect(
        screen.getByText(
          "users.memberOf: 3 entries without details; the account can't read their type, it needs one of: GroupMember.Read.All, Directory.Read.All",
        ),
      ).toBeTruthy();
    });

    it('shows_limited_entries_without_permissions_to_name', () => {
      show('groups', [rel({ column: 'members', limited: 1, permissions: [] })]);
      expect(screen.getByText("groups.members: 1 entry without details; the account can't read their type")).toBeTruthy();
    });

    it('shows_some_refused', () => {
      show('users', [rel({ refused: 3 })]);
      expect(screen.getByText('users.memberOf: no permission for 3 of 40 objects, their values are empty')).toBeTruthy();
    });

    it('shows_filtered_locally', () => {
      show('users', [rel({ filteredLocally: true, objects: 87 })]);
      expect(
        screen.getByText('users.memberOf read for all 87 listed objects; the filter ran locally. Use a filter Graph can apply (==, startswith) to read fewer.'),
      ).toBeTruthy();
    });

    it('shows_the_capped_chip_once_for_two_capped_relationships', () => {
      show('users', [rel({ capped: true }), rel({ column: 'ownedObjects', capped: true })]);
      expect(screen.getAllByText('users: too many objects to read one at a time, values empty')).toHaveLength(1);
    });

    it('shows_the_capped_chip_once_when_perObjectCapped_too', () => {
      show('users', [rel({ capped: true })], { perObjectCapped: true });
      expect(screen.getAllByText('users: too many objects to read one at a time, values empty')).toHaveLength(1);
    });

    it('adds_no_chip_for_a_clean_read', () => {
      show('users', [rel({})]);
      expect(screen.queryByText(/memberOf/)).toBeNull();
      expect(screen.queryByText(/too many objects/)).toBeNull();
    });

    it('counts_relationships_in_the_read_one_at_a_time_chip', () => {
      show('users', [rel({})], { perObject: ['signInActivity'] });
      const chip = screen.getByText('2 columns read one object at a time');
      expect(chip.getAttribute('title')).toBe('users: signInActivity, memberOf');
    });

    it('shows_capped_and_filtered_locally_together', () => {
      show('users', [rel({ capped: true, filteredLocally: true, objects: 150 })]);
      expect(screen.getByText('users: too many objects to read one at a time, values empty')).toBeTruthy();
      expect(
        screen.getByText(
          'users.memberOf: the filter ran locally, so all 150 listed objects counted toward the cap. Use a filter Graph can apply (==, startswith) to read fewer.',
        ),
      ).toBeTruthy();
      expect(screen.queryByText(/read for all/)).toBeNull();
    });

    it('shows_no_filtered_locally_chip_without_objects', () => {
      show('users', [rel({ filteredLocally: true, objects: 0 })]);
      expect(screen.queryByText(/the filter ran locally/)).toBeNull();
    });

    it('leaves_relationship_columns_out_of_the_unreadable_chip', () => {
      show('users', [rel({ capped: true })], { unreadable: ['memberOf', 'mobilePhone'] });
      expect(screen.getByText("mobilePhone: Graph won't list, values empty")).toBeTruthy();
      expect(screen.queryByText(/memberOf, mobilePhone/)).toBeNull();
      expect(screen.queryByText(/memberOf: Graph won't list/)).toBeNull();
    });
  });
});
