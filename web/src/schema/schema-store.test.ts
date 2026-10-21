import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeError } from '../bridge';
import { useTabs } from '../tabs/tab-store';
import type { SchemaView } from '../wire';
import { startSchemaLoading, useSchemas } from './schema-store';

const bridge = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call: bridge.call,
  on: () => () => undefined,
}));

const view = (source: string, generatedAt = '2026-10-21T00:00:00Z'): SchemaView => ({
  source,
  origin: source === 'hunting' ? 'tenant' : 'builtIn',
  fallbackReason: null,
  generatedAt,
  tables: [],
  functions: [],
  complexTypes: {},
});

/** The `schema.get` calls made, as `source` or `source:refresh`. */
const schemaCalls = () =>
  bridge.call.mock.calls
    .filter(([method]) => method === 'schema.get')
    .map(([, p]) => {
      const { source, refresh } = p as { source: string; refresh?: boolean };
      return refresh ? `${source}:refresh` : source;
    });

const settle = () => act(async () => await new Promise((r) => setTimeout(r, 0)));

let stop: () => void = () => undefined;

beforeEach(() => {
  bridge.call.mockReset();
  bridge.call.mockImplementation((method: string, params?: { source?: string }) => {
    if (method === 'schema.get') {
      return Promise.resolve(view(params?.source ?? 'graph'));
    }
    if (method === 'arm.resourceTypes') {
      return Promise.resolve({ types: ['microsoft.storage/storageaccounts'] });
    }
    return Promise.reject(new BridgeError('unknown_method', method));
  });
  useSchemas.getState().reset();
  useTabs.setState({ tabs: [], activeId: null, cursors: {} });
});

afterEach(() => stop());

describe('useSchemas', () => {
  it('schema_loads_lazily_and_resets_on_account_change', async () => {
    useTabs.getState().open('graph');
    stop = startSchemaLoading();
    await settle();

    // Only the sources with a tab are read: nothing for hunting or Resource Graph yet, and no ARM call.
    expect(schemaCalls()).toEqual(['graph']);
    expect(useSchemas.getState().byKey.graph?.source).toBe('graph');
    expect(useSchemas.getState().byKey.hunting).toBeUndefined();
    expect(bridge.call.mock.calls.some(([m]) => m === 'arm.resourceTypes')).toBe(false);

    // The first hunting tab reads the hunting schema, once.
    act(() => {
      useTabs.getState().open('hunting');
    });
    await settle();
    act(() => {
      useTabs.getState().open('hunting');
    });
    await settle();
    expect(schemaCalls()).toEqual(['graph', 'hunting']);

    // The first Resource Graph tab reads its tables and the account's resource types.
    act(() => {
      useTabs.getState().open('arg');
    });
    await settle();
    expect(schemaCalls()).toEqual(['graph', 'hunting', 'arg']);
    expect(useSchemas.getState().resourceTypes).toEqual(['microsoft.storage/storageaccounts']);

    // Another account: everything is read again for the tabs that are open.
    act(() => useSchemas.getState().reset());
    await settle();
    expect(schemaCalls().slice(3).sort()).toEqual(['arg', 'graph', 'hunting']);
  });

  it('an_answer_from_before_a_reset_is_dropped', async () => {
    let answer: (v: SchemaView) => void = () => undefined;
    bridge.call.mockImplementation((method: string) =>
      method === 'schema.get' ? new Promise<SchemaView>((resolve) => (answer = resolve)) : Promise.resolve({ types: [] }),
    );
    const loading = useSchemas.getState().load('hunting');
    act(() => useSchemas.getState().reset());
    answer(view('hunting', '2020-01-01T00:00:00Z'));
    await loading;

    expect(useSchemas.getState().byKey.hunting).toBeUndefined();
  });

  it('the_latest_request_for_a_source_wins', async () => {
    const pending: ((v: SchemaView) => void)[] = [];
    bridge.call.mockImplementation((method: string) =>
      method === 'schema.get' ? new Promise<SchemaView>((resolve) => pending.push(resolve)) : Promise.resolve({ types: [] }),
    );
    const first = useSchemas.getState().load('hunting');
    const refresh = useSchemas.getState().load('hunting', { refresh: true });

    // The refresh answers first; the older read answers after it and must not replace it.
    pending[1]!(view('hunting', '2026-10-21T12:00:00Z'));
    await refresh;
    expect(useSchemas.getState().loading.hunting).toBe(false);
    pending[0]!(view('hunting', '2026-10-20T00:00:00Z'));
    await first;

    expect(useSchemas.getState().byKey.hunting?.generatedAt).toBe('2026-10-21T12:00:00Z');
    expect(useSchemas.getState().loading.hunting).toBe(false);
  });

  it('refresh_reads_the_source_again_and_a_failure_is_kept', async () => {
    await useSchemas.getState().load('hunting');
    await useSchemas.getState().load('hunting', { refresh: true });
    expect(schemaCalls()).toEqual(['hunting', 'hunting:refresh']);

    bridge.call.mockImplementation(() => Promise.reject(new BridgeError('failed', 'Graph is down.')));
    await useSchemas.getState().load('graph');
    expect(useSchemas.getState().errors.graph).toBe('Graph is down.');
  });
});
