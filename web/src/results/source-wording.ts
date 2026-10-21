import type { ArgScope, RunResult } from '../wire';

const count = (n: number) => n.toLocaleString('en-US');
export const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;

/** The requests a hunting or Resource Graph run sent, a request sent again after a wait counted once: the hunting queries, or
 * Resource Graph's pages. */
export function serverRequests(result: RunResult): number {
  const requests = result.diagnostics.filter((e) => e.kind === 'request').length;
  const retries = result.diagnostics.filter((e) => e.kind === 'retry').length;
  return Math.max(0, requests - retries);
}

/** Where a Resource Graph run looked, as the scope picker's trigger words it: "3 subscriptions", the group, or "all I can see"
 * (also when there is no scope: the source's default). */
export function scopeText(scope: ArgScope | null | undefined): string {
  if (scope?.kind === 'subscriptions' && scope.ids.length > 0) {
    return plural(scope.ids.length, 'subscription');
  }
  if (scope?.kind === 'managementGroup' && scope.ids[0]) {
    return scope.ids[0];
  }
  return 'all I can see';
}
