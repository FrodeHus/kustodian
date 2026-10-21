import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId } from './ids';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

const filled = (byte: number) => ({
  getRandomValues: <T extends ArrayBufferView>(a: T) => {
    new Uint8Array(a.buffer, a.byteOffset, a.byteLength).fill(byte);
    return a;
  },
});

describe('newId', () => {
  it('new_id_uses_random_uuid_when_there_is_one', () => {
    const randomUUID = vi.fn(() => '12345678-1234-4123-8123-123456789abc');
    vi.stubGlobal('crypto', { ...filled(0), randomUUID });

    expect(newId()).toBe('12345678-1234-4123-8123-123456789abc');
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  it('new_id_outside_a_secure_context_builds_a_v4_uuid_from_random_values', () => {
    const real = globalThis.crypto;
    // Outside a secure context `randomUUID` is missing; `getRandomValues` is still there.
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array<ArrayBuffer>) => real.getRandomValues(a) });

    const ids = Array.from({ length: 50 }, () => newId());
    ids.forEach((id) => expect(id).toMatch(V4));
    expect(new Set(ids).size).toBe(50);

    // The version and variant bits are set whatever the random bytes are.
    vi.stubGlobal('crypto', filled(0xff));
    expect(newId()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    vi.stubGlobal('crypto', filled(0));
    expect(newId()).toBe('00000000-0000-4000-8000-000000000000');
  });
});
