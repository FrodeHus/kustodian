import { describe, expect, it } from 'vitest';
import { createBridge } from './bridge';
import { createMockTransport } from './bridge.mock';
import { BridgeError } from './bridge';
import type { ArmManagementGroupsAnswer, ArmResourceTypesAnswer, ArmSubscriptionsAnswer, ListedByDefault, RecentRun, RunResult, SchemaView } from './wire';

describe('bridge mock', () => {
  it('mock_answers_the_arm_methods_in_the_hosts_shapes', async () => {
    const bridge = createBridge(createMockTransport());

    const subscriptions = await bridge.call<ArmSubscriptionsAnswer>('arm.subscriptions');
    const groups = await bridge.call<ArmManagementGroupsAnswer>('arm.managementGroups');
    const types = await bridge.call<ArmResourceTypesAnswer>('arm.resourceTypes');

    expect(subscriptions.subscriptions.length).toBeGreaterThan(0);
    for (const subscription of subscriptions.subscriptions) {
      expect(Object.keys(subscription)).toEqual(['id', 'name', 'tenantId', 'state']);
    }
    expect(groups.groups[0]).toEqual({ name: 'contoso-platform', displayName: 'Platform' });
    expect(groups.note).toBeUndefined();
    expect(types.types).toContain('microsoft.keyvault/vaults');
  });

  it('mock_schema_follows_the_source', async () => {
    const bridge = createBridge(createMockTransport());

    const graph = await bridge.call<SchemaView>('schema.get', { source: 'graph' });
    const hunting = await bridge.call<SchemaView>('schema.get', { source: 'hunting' });
    const arg = await bridge.call<SchemaView>('schema.get', { source: 'arg' });

    expect(graph.tables.some((t) => t.name === 'applications')).toBe(true);
    expect(hunting).toMatchObject({ source: 'hunting', origin: 'tenant', fallbackReason: null });
    expect(hunting.functions.map((f) => f.name)).toEqual(['AssignedIPAddresses', 'DeviceFromIP', 'FileProfile', 'SeenBy']);
    expect(hunting.tables[0]?.columns[0]).toEqual({ name: 'Timestamp', type: 'datetime', description: '', filterable: null, listable: null, complexType: null, collection: false });
    expect(arg).toMatchObject({ source: 'arg', origin: 'builtIn', functions: [] });
    expect(arg.tables.map((t) => t.name)).toContain('Resources');
    expect(arg.tables[0]?.path).toBeNull();
    await expect(bridge.call('schema.get', { source: 'raw' })).rejects.toBeInstanceOf(BridgeError);
  });

  it('mock_listed_by_default_is_graphs_only', async () => {
    const bridge = createBridge(createMockTransport());

    const listed = await bridge.call<ListedByDefault>('schema.listedByDefault', { source: 'graph' });

    expect(Object.keys(listed)).toEqual(['tables']);
    expect(listed.tables.users).toEqual(['businessPhones', 'displayName', 'givenName', 'id', 'jobTitle', 'mail', 'mobilePhone', 'officeLocation', 'preferredLanguage', 'surname', 'userPrincipalName']);
    await expect(bridge.call('schema.listedByDefault', { source: 'hunting' })).rejects.toMatchObject({
      code: 'bad_request',
      message: 'Unknown source hunting.',
    });
  });

  it('mock_explain_and_completion_are_graph_only', async () => {
    const bridge = createBridge(createMockTransport());

    await expect(bridge.call('query.explain', { source: 'hunting', kql: 'DeviceInfo' })).rejects.toMatchObject({
      code: 'bad_request',
      message: 'Explain is only available for Microsoft Graph.',
    });
    await expect(bridge.call('query.complete', { source: 'arg', kql: 'Resources', position: 9 })).rejects.toMatchObject({
      code: 'bad_request',
      message: 'Completion comes from the editor for this source.',
    });
    const hunting = await bridge.call<RunResult>('query.run', { tabId: 't', source: 'hunting', kql: 'DeviceInfo', refresh: false });
    expect(hunting.tables).toEqual([]);
    expect(hunting.diagnostics.map((d) => d.detail)).toEqual(['POST security/runHuntingQuery']);
  });

  it('mock_settings_carry_the_arg_rows_limit', async () => {
    const bridge = createBridge(createMockTransport());

    const answer = await bridge.call<{ settings: { limits: Record<string, number> } }>('settings.get');

    expect(answer.settings.limits.argRowsPerRun).toBe(50000);
  });

  it('mock_run_refuses_options_the_host_refuses_and_recent_keeps_them', async () => {
    const bridge = createBridge(createMockTransport());

    await expect(
      bridge.call('query.run', { tabId: 't', source: 'hunting', kql: 'DeviceInfo', refresh: false, options: { timespan: 'P45D', scope: null } }),
    ).rejects.toMatchObject({ code: 'bad_request', message: 'The timespan can cover at most 30 days.' });
    await expect(
      bridge.call('query.run', { tabId: 't', source: 'arg', kql: 'Resources', refresh: false, options: { timespan: null, scope: { kind: 'subscriptions', ids: [] } } }),
    ).rejects.toMatchObject({ code: 'bad_request', message: 'Pick 1 to 100 subscriptions.' });

    const options = { timespan: '2026-10-01T00:00:00Z/2026-10-08T00:00:00Z', scope: null };
    await bridge.call('query.run', { tabId: 't', source: 'hunting', kql: 'DeviceInfo', refresh: false, options });
    expect(await bridge.call<{ runs: RecentRun[] }>('recent.list')).toMatchObject({ runs: [{ source: 'hunting', text: 'DeviceInfo', options }] });
    await expect(bridge.call('account.consent', { key: 'mock-account', audience: 'arm' })).resolves.toEqual({});
  });
});
