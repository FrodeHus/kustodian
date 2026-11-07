import type { CatalogItem, SolutionManifest } from '../wire';

/** A catalog entry for tests; `over` replaces manifest fields. */
export function solution(over: Partial<SolutionManifest> = {}, item: Partial<Omit<CatalogItem, 'manifest'>> = {}): CatalogItem {
  return {
    manifest: {
      version: 1,
      id: 'entra-risky-users',
      name: 'Entra risky users',
      solutionVersion: '1.2.0',
      description: 'Weekly review of risky users and their sign-ins.',
      author: 'frodehus',
      support: 'kustodian',
      categories: ['Identity'],
      sources: ['graph', 'hunting'],
      minAppVersion: '1.0.0',
      requires: null,
      content: { queries: ['risky-users', 'risky-sign-ins'], workbooks: ['weekly-review'], tools: [] },
      ...over,
    },
    compatible: true,
    installedVersion: null,
    ...item,
  };
}
