/**
 * A new random id: an RFC 4122 version 4 UUID in "D" format (the host takes these as run ids). `crypto.randomUUID` exists only
 * in a secure context, which the app's origin may not be on every platform; `crypto.getRandomValues` works everywhere, so the
 * UUID is built from it when `randomUUID` is missing (ruling 21).
 */
export function newId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
