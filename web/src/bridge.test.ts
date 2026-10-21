import { describe, expect, it } from 'vitest';
import { BridgeError, createBridge, type Transport } from './bridge';

/** A transport that records what the page sends and lets a test play the host. */
function fakeTransport() {
  const sent: { id: string; method: string; params: Record<string, unknown> }[] = [];
  let receive: (message: string) => void = () => undefined;
  const transport: Transport = {
    send: (message) => {
      sent.push(JSON.parse(message) as (typeof sent)[number]);
    },
    onMessage: (callback) => {
      receive = callback;
    },
  };
  return {
    transport,
    sent,
    reply: (message: unknown) => receive(JSON.stringify(message)),
  };
}

describe('bridge', () => {
  it('call_resolves_matching_id_only', async () => {
    const host = fakeTransport();
    const { call } = createBridge(host.transport);

    const first = call<string>('app.info');
    const second = call<string>('account.list');
    const [a, b] = host.sent;

    host.reply({ id: b?.id, result: 'second' });
    expect(await second).toBe('second');

    let firstSettled = false;
    void first.then(() => {
      firstSettled = true;
    });
    host.reply({ id: 'unknown', result: 'stray' });
    await Promise.resolve();
    expect(firstSettled).toBe(false);

    host.reply({ id: a?.id, result: 'first' });
    expect(await first).toBe('first');
  });

  it('call_rejects_with_bridge_error', async () => {
    const host = fakeTransport();
    const { call } = createBridge(host.transport);

    const pending = call('query.run', { tabId: 't1' });
    host.reply({ id: host.sent[0]?.id, error: { code: 'bad_request', message: 'A run needs kql.' } });

    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeError);
    expect(error).toMatchObject({ code: 'bad_request', message: 'A run needs kql.' });
  });

  it('on_unsubscribe_stops_delivery', () => {
    const host = fakeTransport();
    const { on } = createBridge(host.transport);
    const seen: unknown[] = [];

    const off = on('query.progress', (data) => seen.push(data));
    host.reply({ event: 'query.progress', data: 1 });
    host.reply({ event: 'other.event', data: 'ignored' });
    off();
    host.reply({ event: 'query.progress', data: 2 });

    expect(seen).toEqual([1]);
  });

  it('abort_signal_sends_query_cancel', async () => {
    const host = fakeTransport();
    const { call } = createBridge(host.transport);
    const controller = new AbortController();

    const pending = call('query.run', { tabId: 'tab-7', source: 'graph', kql: 'users' }, controller.signal);
    controller.abort();

    const error = await pending.catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'cancelled' });
    expect(host.sent.map((m) => m.method)).toEqual(['query.run', 'query.cancel']);
    expect(host.sent[1]?.params).toEqual({ tabId: 'tab-7' });
  });
});
