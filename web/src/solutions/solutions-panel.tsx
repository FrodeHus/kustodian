import { useCallback, useEffect, useState } from 'react';
import { call } from '../bridge';
import { useRevisions } from '../library/saving';
import { errorText } from '../shell/errors';
import { ErrorReportActions, type Shown } from '../shell/error-report';
import { reportIdOf } from '../shell/report-id';
import { SourceBadge } from '../tabs/source-badge';
import { SOURCES } from '../tabs/sources';
import type { Catalog, CatalogItem, Source } from '../wire';
import { filterCatalog, type CatalogFilter } from './filter';
import { useSolutionDialog } from './solution-store';

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const fetched = (at: string) =>
  new Date(at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const isSource = (s: string): s is Source => Object.hasOwn(SOURCES, s);

/** "Kustodian" for the solutions Kustodian maintains, "Community" for the rest. */
export function SupportBadge({ support }: { support: string }) {
  return support === 'kustodian' ? <span className="tag">Kustodian</span> : <span className="tag plain">Community</span>;
}

/** The badges of the sources a solution queries; a source this app doesn't know is left out. */
function SolutionSources({ sources }: { sources: string[] }) {
  return sources.filter(isSource).map((s) => <SourceBadge key={s} source={s} titled />);
}

type Show = '' | 'kustodian' | 'community' | 'installed';

/** The Community Solutions panel (mockup Solutions): the catalog with a search and three filters; a row opens its dialog. */
export function SolutionsPanel() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [problem, setProblem] = useState<Shown | null>(null);
  const [busy, setBusy] = useState(true);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [source, setSource] = useState('');
  const [show, setShow] = useState<Show>('');

  const load = useCallback((refresh: boolean) => {
    call<Catalog>('solution.list', { refresh }).then(
      (c) => {
        setCatalog(c);
        setProblem(null);
        setBusy(false);
      },
      (e: unknown) => {
        setProblem({ text: `The catalog couldn’t be read: ${errorText(e)}`, reportId: reportIdOf(e) });
        setBusy(false);
      },
    );
  }, []);
  // An install or uninstall bumps the library revision: the rows' Installed state follows.
  const revision = useRevisions((s) => s.library);
  useEffect(() => load(false), [load, revision]);

  const all = catalog?.solutions ?? [];
  const filter: CatalogFilter = {
    search,
    category: category || null,
    source: isSource(source) ? source : null,
    support: show === 'kustodian' || show === 'community' ? show : null,
    installed: show === 'installed',
  };
  const shown = filterCatalog(all, filter);
  const categories = [...new Set(all.flatMap((s) => s.manifest.categories))].sort((a, b) => a.localeCompare(b));

  const row = ({ manifest: m, compatible, installedVersion }: CatalogItem) => {
    const counts = [
      m.content.queries.length > 0 && count(m.content.queries.length, 'query', 'queries'),
      m.content.workbooks.length > 0 && count(m.content.workbooks.length, 'workbook', 'workbooks'),
    ].filter(Boolean);
    return (
      <li key={m.id}>
        <button
          type="button"
          className={`side-open flex-col !items-stretch !gap-[3px] py-2 ${compatible ? '' : 'opacity-60'}`}
          onClick={() => useSolutionDialog.getState().open(m.id, compatible)}
        >
          <span className="flex items-center gap-1.5 font-semibold">
            <span className="truncate">{m.name}</span>
            <SupportBadge support={m.support} />
          </span>
          <span className="text-[11.5px] text-muted">{m.description}</span>
          <span className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-faint">
            <SolutionSources sources={m.sources} />
            {counts.join(' · ')}
            {installedVersion !== null ? (
              <span className="ml-auto text-[11px] font-medium whitespace-nowrap text-ok">Installed</span>
            ) : (
              !compatible && <span className="ml-auto text-[11px] font-medium whitespace-nowrap">Needs Kustodian {m.minAppVersion}</span>
            )}
          </span>
        </button>
      </li>
    );
  };

  return (
    <aside className="side" aria-label="Community Solutions">
      <div className="flex items-center gap-2 pr-3">
        <h2 className="grow">Community Solutions</h2>
        <button
          type="button"
          className="btn ghost h-[22px] px-2 text-[11px]"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            load(true);
          }}
        >
          Refresh
        </button>
      </div>
      <input
        className="search"
        type="search"
        aria-label="Find a solution"
        placeholder={catalog ? `Find among ${count(all.length, 'solution', 'solutions')}` : 'Find a solution'}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="flex gap-1.5 px-3 pb-2.5">
        <select
          className="textbox h-[26px] min-w-0 flex-1 px-1.5 text-[11.5px]"
          aria-label="Category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          className="textbox h-[26px] min-w-0 flex-1 px-1.5 text-[11.5px]"
          aria-label="Source"
          value={source}
          onChange={(e) => setSource(e.target.value)}
        >
          <option value="">All sources</option>
          {(['graph', 'hunting', 'arg'] as const).map((s) => (
            <option key={s} value={s}>
              {SOURCES[s].name}
            </option>
          ))}
        </select>
        <select
          className="textbox h-[26px] min-w-0 flex-1 px-1.5 text-[11.5px]"
          aria-label="Show"
          value={show}
          onChange={(e) => setShow(e.target.value as Show)}
        >
          <option value="">All</option>
          <option value="kustodian">Kustodian</option>
          <option value="community">Community</option>
          <option value="installed">Installed</option>
        </select>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {problem && (
          <p role="alert" className="m-0 px-[14px] pb-2 text-[12px] text-bad">
            {problem.text}
            <ErrorReportActions reportId={problem.reportId} uiSections={{ message: problem.text }} />
          </p>
        )}
        {catalog && shown.length === 0 && (
          <p className="faint m-0 px-[14px] text-[12px]">
            {all.length === 0 ? 'The catalog has no solutions yet.' : 'No solution matches.'}
          </p>
        )}
        <ul className="side-list">{shown.map(row)}</ul>
      </div>
      {catalog && (
        <p className={`m-0 border-t border-line px-[14px] py-2 text-[11.5px] ${catalog.offline ? 'text-warn' : 'text-faint'}`}>
          {catalog.offline
            ? `Showing the catalog from ${fetched(catalog.fetchedAt)}. Kustodian couldn't reach GitHub.`
            : `Catalog fetched ${fetched(catalog.fetchedAt)}`}
        </p>
      )}
    </aside>
  );
}
