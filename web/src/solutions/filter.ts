import type { CatalogItem, Source } from '../wire';

export interface CatalogFilter {
  search: string;
  category: string | null;
  source: Source | null;
  support: 'kustodian' | 'community' | null;
  /** True: only installed solutions. */
  installed: boolean;
}

/** The solutions every set filter keeps; the search looks in name, description, author and categories, ignoring case. */
export function filterCatalog(items: CatalogItem[], f: CatalogFilter): CatalogItem[] {
  const needle = f.search.trim().toLowerCase();
  return items.filter(({ manifest: m, installedVersion }) => {
    const text = [m.name, m.description, m.author, ...m.categories].join('\n').toLowerCase();
    return (
      (!needle || text.includes(needle)) &&
      (f.category === null || m.categories.includes(f.category)) &&
      (f.source === null || m.sources.includes(f.source)) &&
      (f.support === null || m.support === f.support) &&
      (!f.installed || installedVersion !== null)
    );
  });
}
