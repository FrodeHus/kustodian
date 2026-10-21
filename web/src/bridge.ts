/**
 * The page's side of the host bridge. Messages are JSON strings:
 * request `{ id, method, params }`, response `{ id, result }` or `{ id, error: { code, message } }`,
 * event `{ event, data }`.
 *
 * Under Photino the transport is `window.external.sendMessage` / `receiveMessage`. Without them (`vite dev`, tests) the
 * bridge talks to `bridge.mock.ts`.
 */

export class BridgeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

export interface Transport {
  send(message: string): void;
  /** Registers the one callback that receives every message from the host. */
  onMessage(callback: (message: string) => void): void;
}

export interface Bridge {
  call<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T>;
  on(event: string, handler: (data: unknown) => void): () => void;
}

interface Pending {
  resolve: (value: never) => void;
  reject: (reason: BridgeError) => void;
}

interface Incoming {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
  event?: unknown;
  data?: unknown;
}

export function createBridge(transport: Transport): Bridge {
  const pending = new Map<string, Pending>();
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  let counter = 0;

  const nextId = () => `${++counter}`;

  transport.onMessage((text) => {
    let message: Incoming;
    try {
      message = JSON.parse(text) as Incoming;
    } catch {
      return;
    }

    if (typeof message.event === 'string') {
      for (const handler of [...(handlers.get(message.event) ?? [])]) {
        handler(message.data);
      }
      return;
    }

    if (typeof message.id !== 'string') {
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) {
      return;
    }
    pending.delete(message.id);
    if (message.error) {
      const { code, message: text } = message.error;
      entry.reject(new BridgeError(typeof code === 'string' ? code : 'failed', typeof text === 'string' ? text : 'The request failed.'));
    } else {
      entry.resolve(message.result as never);
    }
  });

  function send(method: string, params: unknown): string {
    const id = nextId();
    transport.send(JSON.stringify({ id, method, params: params ?? {} }));
    return id;
  }

  function call<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(new BridgeError('cancelled', 'The request was cancelled.'));
    }

    return new Promise<T>((resolve, reject) => {
      const id = send(method, params);
      pending.set(id, { resolve, reject });

      signal?.addEventListener(
        'abort',
        () => {
          if (!pending.delete(id)) {
            return;
          }
          // A cancelled run also stops on the host; its late answer is ignored.
          if (method === 'query.run') {
            const tabId = (params as { tabId?: unknown } | undefined)?.tabId;
            if (typeof tabId === 'string') {
              send('query.cancel', { tabId });
            }
          }
          reject(new BridgeError('cancelled', 'The request was cancelled.'));
        },
        { once: true },
      );
    });
  }

  function on(event: string, handler: (data: unknown) => void): () => void {
    let set = handlers.get(event);
    if (!set) {
      set = new Set();
      handlers.set(event, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  return { call, on };
}

interface PhotinoExternal {
  sendMessage(message: string): void;
  receiveMessage(callback: (message: string) => void): void;
}

function photinoExternal(): PhotinoExternal | null {
  const external = (window as { external?: Partial<PhotinoExternal> }).external;
  return typeof external?.sendMessage === 'function' && typeof external.receiveMessage === 'function'
    ? (external as PhotinoExternal)
    : null;
}

function defaultTransport(): Transport {
  const photino = photinoExternal();
  if (photino) {
    return {
      send: (message) => photino.sendMessage(message),
      onMessage: (callback) => photino.receiveMessage(callback),
    };
  }

  // No host: answer from fixtures. The mock is loaded on demand, so a hosted build never needs it.
  const mock = import('./bridge.mock').then((m) => m.createMockTransport());
  let receive: (message: string) => void = () => undefined;
  void mock.then((m) => m.onMessage((message) => receive(message)));
  return {
    send: (message) => {
      void mock.then((m) => m.send(message));
    },
    onMessage: (callback) => {
      receive = callback;
    },
  };
}

let shared: Bridge | undefined;

function bridge(): Bridge {
  shared ??= createBridge(defaultTransport());
  return shared;
}

/** Calls a host method. Rejects with a {@link BridgeError}; aborting `signal` rejects with code `cancelled`. */
export function call<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
  return bridge().call<T>(method, params, signal);
}

/** Subscribes to a host event; returns the function that unsubscribes. */
export function on(event: string, handler: (data: unknown) => void): () => void {
  return bridge().on(event, handler);
}
