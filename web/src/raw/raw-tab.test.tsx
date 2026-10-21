import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeError } from '../bridge';
import { bindGlobalKeys, runCommand } from '../shell/commands';
import schema from '../fixtures/graph-schema.json';
import { useTabs } from '../tabs/tab-store';
import type { RawResponse, SchemaView } from '../wire';
import { completePath } from './path-completion';
import { headerProblem, openRaw, rawRequest, sendableHeaders, useRawResponses } from './raw-request';
import { RawTab } from './raw-tab';

const bridge = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call: bridge.call,
  on: () => () => undefined,
}));

const graph = schema as SchemaView;

function response(body: unknown, nextLink: string | null = null): RawResponse {
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'request-id': 'req-1' },
    body: JSON.stringify(body),
    durationMs: 120,
    nextLink,
    truncated: false,
    accountKey: 'k1',
  };
}

const NEXT = 'https://graph.microsoft.com/beta/me/memberOf?$skiptoken=abc';

function openTab(text = 'me/memberOf') {
  const id = openRaw();
  useTabs.getState().setText(id, text);
  return id;
}

/** The tab is a prop: the harness reads it from the store as it changes, as the app does. */
function Harness({ id, accountKey, onSignIn }: { id: string; accountKey: string | undefined; onSignIn: () => void }) {
  const tab = useTabs((s) => s.tabs.find((t) => t.id === id));
  return tab ? <RawTab tab={tab} schema={graph} defaultVersion="beta" accountKey={accountKey} onSignIn={onSignIn} /> : null;
}

function renderTab(id: string, accountKey: string | undefined = 'k1', onSignIn = vi.fn()) {
  const view = render(<Harness id={id} accountKey={accountKey} onSignIn={onSignIn} />);
  return { ...view, switchAccount: (key: string) => view.rerender(<Harness id={id} accountKey={key} onSignIn={onSignIn} />) };
}

beforeEach(() => {
  bridge.call.mockReset();
  useTabs.setState({ tabs: [], activeId: null, cursors: {} });
  useRawResponses.setState({ responses: {} });
});

describe('RawTab', () => {
  it('raw_tab_is_never_dirty_and_never_runs', async () => {
    const id = openTab();
    expect(useTabs.getState().tabs[0]).toMatchObject({ source: 'raw', dirty: false, text: 'me/memberOf' });

    await useTabs.getState().run(id, 'all');
    expect(bridge.call).not.toHaveBeenCalled();
  });

  it('raw_tab_sends_and_shows_status_and_json', async () => {
    bridge.call.mockResolvedValue(response({ value: [{ id: '1', displayName: 'SOC Analysts' }] }));
    const id = openTab('/me/memberOf');
    renderTab(id);

    fireEvent.click(screen.getByRole('button', { name: 'Add header' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Header 1 name' }), { target: { value: 'ConsistencyLevel' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Header 1 value' }), { target: { value: 'eventual' } });
    // The headers (and the version) are kept with the tab, so the session keeps them.
    expect(rawRequest(useTabs.getState().tabs[0]!).headers).toEqual([{ name: 'ConsistencyLevel', value: 'eventual' }]);

    fireEvent.click(screen.getByRole('button', { name: /^Send/ }));

    expect(await screen.findByText('200 OK')).toBeTruthy();
    // A leading slash is dropped: the host takes the path relative to the version.
    expect(bridge.call).toHaveBeenCalledWith('raw.send', { version: 'beta', path: 'me/memberOf', headers: { ConsistencyLevel: 'eventual' } });
    expect(screen.getByText(/120 ms/)).toBeTruthy();
    const body = screen.getByRole('region', { name: 'Response body' });
    expect(body.textContent).toContain('"SOC Analysts"');
    expect(body.textContent).toContain('displayName');

    // The JSON folds.
    const value = within(body).getByRole('button', { name: /^value/ });
    expect(value.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(value);
    expect(body.textContent).not.toContain('SOC Analysts');

    fireEvent.click(screen.getByRole('tab', { name: 'Headers' }));
    expect(screen.getByText('request-id')).toBeTruthy();

    // The tab is named after the request, and remembers the version it was sent with.
    expect(useTabs.getState().tabs[0]).toMatchObject({ title: 'GET /me/memberOf' });
    expect(rawRequest(useTabs.getState().tabs[0]!).version).toBe('beta');
  });

  it('raw_next_page_appends', async () => {
    bridge.call
      .mockResolvedValueOnce(response({ value: [{ displayName: 'First' }] }, NEXT))
      .mockResolvedValueOnce(response({ value: [{ displayName: 'Second' }] }));
    renderTab(openTab());

    fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Next page' }));

    await screen.findByText('"Second"');
    expect(bridge.call).toHaveBeenLastCalledWith('raw.next', { nextLink: NEXT, accountKey: 'k1' });
    expect(screen.getByText('"First"')).toBeTruthy();
    expect(screen.getByText('Page 2')).toBeTruthy();
    // The last page has no next link.
    expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull();
  });

  it('raw_next_page_stops_when_the_account_changed', async () => {
    bridge.call.mockResolvedValueOnce(response({ value: [] }, NEXT));
    const view = renderTab(openTab());

    fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
    expect((await screen.findByRole('button', { name: 'Next page' })).hasAttribute('disabled')).toBe(false);

    view.switchAccount('k2');
    expect(screen.getByRole('button', { name: 'Next page' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/The account changed since the first page/)).toBeTruthy();
  });

  it('raw_next_page_goes_out_for_the_account_the_host_sent_the_first_page_for', async () => {
    // The host answered for k3 (the active account changed while the request was out): next pages go out for k3.
    bridge.call
      .mockResolvedValueOnce({ ...response({ value: [] }, NEXT), accountKey: 'k3' })
      .mockResolvedValueOnce({ ...response({ value: [] }), accountKey: 'k3' });
    const view = renderTab(openTab());

    fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
    await screen.findByRole('button', { name: 'Next page' });
    view.switchAccount('k3');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));

    await waitFor(() => expect(bridge.call).toHaveBeenLastCalledWith('raw.next', { nextLink: NEXT, accountKey: 'k3' }));
  });

  it('raw_next_page_for_an_account_no_longer_signed_in_offers_sign_in', async () => {
    bridge.call
      .mockResolvedValueOnce(response({ value: [] }, NEXT))
      .mockRejectedValueOnce(new BridgeError('signInNeeded', 'Sign in to run this query.'));
    const onSignIn = vi.fn();
    renderTab(openTab(), 'k1', onSignIn);

    fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Next page' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));

    expect(onSignIn).toHaveBeenCalledOnce();
  });

  it('raw_proxy_hop_by_hop_and_content_headers_are_refused_and_never_kept', async () => {
    bridge.call.mockResolvedValue(response({ value: [] }));
    const id = openTab();
    renderTab(id);
    const add = screen.getByRole('button', { name: 'Add header' });
    fireEvent.click(add);
    fireEvent.click(add);

    fireEvent.change(screen.getByRole('textbox', { name: 'Header 1 name' }), { target: { value: 'Proxy-Authorization' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Header 1 value' }), { target: { value: 'Basic proxy-secret' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Header 2 name' }), { target: { value: 'ConsistencyLevel' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Header 2 value' }), { target: { value: 'eventual' } });
    expect(screen.getByText("The Proxy-Authorization header can't be set from the raw tab.")).toBeTruthy();
    for (const name of ['Connection', 'Keep-Alive', 'TE', 'Trailer', 'Transfer-Encoding', 'Upgrade', 'Expect', 'Content-Type', 'Content-Length', 'Content-Encoding', 'proxy-connection']) {
      expect(headerProblem(name, 'x')).toBe(`The ${name} header can't be set from the raw tab.`);
    }
    // What the session would keep of the tab's headers.
    expect(sendableHeaders(rawRequest(useTabs.getState().tabs[0]!).headers)).toEqual([{ name: 'ConsistencyLevel', value: 'eventual' }]);
  });

  it('raw_path_completion_offers_entity_sets', () => {
    expect(completePath(graph, 'us', 2)).toEqual({ from: 0, items: ['users'] });
    expect(completePath(graph, 'users?$select=id,disp', 21)).toEqual({ from: 17, items: ['displayName'] });
    expect(completePath(graph, 'users?$filter=account', 21).items).toEqual(['accountEnabled']);
    expect(completePath(graph, 'users?$to', 9).items).toEqual(['$top']);
    expect(completePath(graph, 'users/', 6).items).toEqual([]);
    // Graph paths, not KQL names: a nested collection completes with its slash, and its own columns.
    expect(completePath(graph, 'auditLogs/s', 11)).toEqual({ from: 0, items: ['auditLogs/signIns'] });
    expect(completePath(graph, 'auditLogs_', 10).items).toEqual([]);
    expect(completePath(graph, 'auditLogs/signIns?$select=', 26).items).toEqual(['id', 'createdDateTime', 'userPrincipalName', 'appDisplayName', 'ipAddress']);
    // The table whose path is the longest prefix of the typed path.
    expect(completePath(graph, 'auditLogs/signIns/x?$select=app', 31).items).toEqual(['appDisplayName']);

    const id = openTab('');
    renderTab(id);
    const path = screen.getByRole('combobox', { name: 'Request path' });
    fireEvent.change(path, { target: { value: 'us', selectionStart: 2 } });
    const list = screen.getByRole('listbox', { name: 'Completions' });
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['users']);

    fireEvent.keyDown(path, { key: 'Enter' });
    expect(useTabs.getState().tabs[0]!.text).toBe('users');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(bridge.call).not.toHaveBeenCalled();
  });

  it('open_array_as_kql_tab_creates_graph_tab', async () => {
    bridge.call.mockResolvedValue(response({ value: [{ id: '1', displayName: 'SOC Analysts' }] }));
    renderTab(openTab('me/memberOf?$top=5'));

    fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open value as a KQL tab' }));

    const { tabs, activeId } = useTabs.getState();
    expect(tabs).toHaveLength(2);
    const opened = tabs[1]!;
    expect(activeId).toBe(opened.id);
    expect(opened).toMatchObject({ source: 'graph', title: 'memberOf_rows', dirty: false });
    expect(opened.text).toBe('let memberOf_rows = datatable(id:string, displayName:string) [\n    "1", "SOC Analysts"\n];\nmemberOf_rows');
  });

  it('raw_tab_keeps_its_request_in_the_tab_for_the_session', () => {
    const id = openRaw({ path: 'me', version: 'v1.0' });
    renderTab(id);

    fireEvent.click(screen.getByRole('button', { name: 'Add header' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Header 1 name' }), { target: { value: 'Prefer' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Version' }), { target: { value: 'beta' } });

    expect(useTabs.getState().tabs[0]!.raw).toEqual({ version: 'beta', headers: [{ name: 'Prefer', value: '' }] });
    expect(useTabs.getState().tabs[0]!.parameters).toEqual([]);
  });

  it('raw_header_refusals_show_as_soon_as_they_are_typed', () => {
    renderTab(openTab());
    const add = screen.getByRole('button', { name: 'Add header' });
    fireEvent.click(add);
    fireEvent.click(add);
    fireEvent.click(add);

    fireEvent.change(screen.getByRole('textbox', { name: 'Header 1 name' }), { target: { value: 'Authorization' } });
    expect(screen.getByText("The Authorization header can't be set from the raw tab.")).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Header 1 name' }).getAttribute('aria-invalid')).toBe('true');

    fireEvent.change(screen.getByRole('textbox', { name: 'Header 1 name' }), { target: { value: 'Prefer' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Header 2 name' }), { target: { value: 'prefer' } });
    expect(screen.getByText('Prefer is set again below; only the last one is sent.')).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: 'Header 3 value' }), { target: { value: 'orphan' } });
    expect(screen.getByText('This header has no name, so it isn’t sent.')).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: 'Header 2 name' }), { target: { value: 'X-Line' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Header 2 value' }), { target: { value: 'caf\u00e9' } });
    expect(screen.getByText("The X-Line header's value can only have printable ASCII characters.")).toBeTruthy();
    expect(bridge.call).not.toHaveBeenCalled();
  });

  it('raw_send_and_next_are_commands_and_mod_enter_sends_from_anywhere_on_the_tab', async () => {
    bridge.call.mockResolvedValueOnce(response({ value: [{ displayName: 'First' }] }, NEXT)).mockResolvedValueOnce(response({ value: [] }));
    const unbind = bindGlobalKeys();
    renderTab(openTab());
    fireEvent.click(screen.getByRole('button', { name: 'Add header' }));
    expect(runCommand('raw.next')).toBe(false);

    // From a header field, a text field where other shortcuts don't fire.
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Header 1 name' }), { key: 'Enter', code: 'Enter', ctrlKey: true });
    await screen.findByText('"First"');
    expect(bridge.call).toHaveBeenCalledWith('raw.send', expect.objectContaining({ path: 'me/memberOf' }));

    act(() => void runCommand('raw.next'));
    await waitFor(() => expect(bridge.call).toHaveBeenLastCalledWith('raw.next', { nextLink: NEXT, accountKey: 'k1' }));
    unbind();
  });

  it('raw_version_and_next_link_refusals_show_beside_their_controls', async () => {
    bridge.call
      .mockRejectedValueOnce(new BridgeError('bad_request', 'The version must be beta or v1.0.'))
      .mockResolvedValueOnce(response({ value: [] }, NEXT))
      .mockRejectedValueOnce(new BridgeError('bad_request', 'A next link must be an https URL on graph.microsoft.com.'));
    renderTab(openTab());

    fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
    const version = screen.getByRole('combobox', { name: 'Version' });
    await waitFor(() => expect(version.getAttribute('aria-invalid')).toBe('true'));
    expect(document.getElementById(version.getAttribute('aria-describedby')!)?.textContent).toBe('The version must be beta or v1.0.');
    expect(screen.getByRole('combobox', { name: 'Request path' }).getAttribute('aria-invalid')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
    const next = await screen.findByRole('button', { name: 'Next page' });
    fireEvent.click(next);
    await waitFor(() => expect(next.getAttribute('aria-describedby')).not.toBeNull());
    expect(document.getElementById(next.getAttribute('aria-describedby')!)?.textContent).toBe('A next link must be an https URL on graph.microsoft.com.');
    expect(screen.getByRole('combobox', { name: 'Request path' }).getAttribute('aria-invalid')).toBe('false');
  });

  it('raw_path_refusals_that_mention_the_version_stay_with_the_path', async () => {
    bridge.call.mockRejectedValueOnce(new BridgeError('bad_request', 'The path must be relative to the version, not a URL.'));
    renderTab(openTab('https://graph.microsoft.com/beta/me'));

    fireEvent.click(screen.getByRole('button', { name: /^Send/ }));

    const path = screen.getByRole('combobox', { name: 'Request path' });
    await waitFor(() => expect(path.getAttribute('aria-invalid')).toBe('true'));
    expect(screen.getByRole('alert').textContent).toBe('The path must be relative to the version, not a URL.');
    expect(screen.getByRole('combobox', { name: 'Version' }).getAttribute('aria-invalid')).toBe('false');
  });

  it('raw_send_trims_names_and_keeps_the_last_of_names_that_differ_only_in_case', async () => {
    bridge.call.mockResolvedValue(response({ value: [] }));
    const id = openTab();
    useTabs.getState().setRaw(id, {
      version: null,
      headers: [
        { name: ' Prefer ', value: 'first' },
        { name: 'prefer', value: 'second' },
        { name: 'ConsistencyLevel', value: 'eventual' },
        { name: '  ', value: 'orphan' },
      ],
    });
    renderTab(id);
    expect(screen.getByText('Prefer is set again below; only the last one is sent.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Send/ }));

    await waitFor(() =>
      expect(bridge.call).toHaveBeenCalledWith('raw.send', { version: 'beta', path: 'me/memberOf', headers: { prefer: 'second', ConsistencyLevel: 'eventual' } }),
    );
  });

  it('raw_send_is_enabled_only_for_the_active_tab', () => {
    const id = openTab();
    renderTab(id);
    expect(runCommand('raw.send')).toBe(true);

    act(() => void useTabs.getState().open('graph'));
    expect(runCommand('raw.send')).toBe(false);
  });

  it('raw_refusals_show_beside_their_field', async () => {
    bridge.call.mockRejectedValueOnce(new BridgeError('bad_request', 'The Cookie header can’t be set from the raw tab.'));
    renderTab(openTab());

    fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
    const headers = screen.getByRole('region', { name: 'Request headers' });
    expect((await within(headers).findByRole('alert')).textContent).toBe('The Cookie header can’t be set from the raw tab.');

    bridge.call.mockRejectedValueOnce(new BridgeError('bad_request', 'The path must stay on Graph.'));
    fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
    await waitFor(() => expect(within(headers).queryByRole('alert')).toBeNull());
    expect(screen.getByRole('alert').textContent).toBe('The path must stay on Graph.');
    expect(screen.getByRole('combobox', { name: 'Request path' }).getAttribute('aria-invalid')).toBe('true');
  });

  it('raw_without_an_account_offers_sign_in', async () => {
    bridge.call.mockRejectedValueOnce(new BridgeError('signInNeeded', 'Sign in to run this query.'));
    const onSignIn = vi.fn();
    renderTab(openTab(), undefined, onSignIn);

    fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(onSignIn).toHaveBeenCalledOnce();
    expect(screen.getByText('Sign in to run this query.')).toBeTruthy();
  });

  it('raw_response_survives_switching_tabs', async () => {
    bridge.call.mockResolvedValue(response({ value: [{ displayName: 'Kept' }] }));
    const id = openTab();
    const first = renderTab(id);
    fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
    await screen.findByText('"Kept"');
    first.unmount();

    act(() => void renderTab(id));
    expect(screen.getByText('"Kept"')).toBeTruthy();
  });
});
