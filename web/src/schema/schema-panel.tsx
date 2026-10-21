import { type ReactNode, useMemo, useState } from 'react';
import { ConsentButton } from '../signin/consent-button';
import type { SchemaColumn, SchemaFunction, SchemaTable, SchemaView, Source } from '../wire';
import type { ResourceTypesFix } from './schema-store';

interface Listed {
  table: SchemaTable;
  columns: SchemaColumn[];
  /** Opened because the search matched its columns rather than its name. */
  open: boolean;
}

/** Tables whose name or Graph path (`auditLogs/` finds the audit tables) matches the search with all their columns, and tables
 * with matching columns opened on just those. */
function search(tables: SchemaTable[], text: string): Listed[] {
  const needle = text.trim().toLowerCase();
  return tables.flatMap((table): Listed[] => {
    if (table.name.toLowerCase().includes(needle) || (table.path?.toLowerCase().includes(needle) ?? false)) {
      return [{ table, columns: table.columns, open: false }];
    }
    const columns = table.columns.filter((c) => c.name.toLowerCase().includes(needle));
    return columns.length > 0 ? [{ table, columns, open: true }] : [];
  });
}

/** Graph's data areas in display order (owner-approved). The host decides each table's area (`graph-areas.json`); an area this
 * list doesn't know (a newer host) shows just before Other, which is always last. The host's `GraphAreas.Names` is the same
 * list: change them together. */
const AREAS = [
  'Users, groups and directory',
  'Apps and permissions',
  'Sign-in and audit logs',
  'Risk and identity protection',
  'Access reviews and privileged roles',
  'Policies and Conditional Access',
  'Devices and Intune',
  'Security',
  'Mail, Teams and files',
  'Reports and usage',
];
const OTHER = 'Other';
/** The area big enough (about 170 tables) to split once more by first path segment. */
const SPLIT_AREA = 'Devices and Intune';
const TOP_LEVEL = 'Top level';

interface Group {
  name: string;
  items: Listed[];
}

function grouped(items: Listed[], keyOf: (table: SchemaTable) => string): Map<string, Listed[]> {
  const groups = new Map<string, Listed[]>();
  for (const item of items) {
    const key = keyOf(item.table);
    const list = groups.get(key);
    if (list) {
      list.push(item);
    } else {
      groups.set(key, [item]);
    }
  }
  return groups;
}

/** The tables by area, in the fixed order; areas without tables are left out. */
function byArea(items: Listed[]): Group[] {
  const rank = (area: string) => (area === OTHER ? AREAS.length + 1 : AREAS.includes(area) ? AREAS.indexOf(area) : AREAS.length);
  return [...grouped(items, (t) => t.area ?? OTHER)]
    .map(([name, list]) => ({ name, items: list }))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

/** The tables by their path's first segment, largest first; top-level collections ("Top level") last. */
function bySegment(items: Listed[]): Group[] {
  const segmentOf = (t: SchemaTable) => {
    const slash = t.path?.indexOf('/') ?? -1;
    return t.path && slash > 0 ? t.path.slice(0, slash) : TOP_LEVEL;
  };
  const last = (name: string) => (name === TOP_LEVEL ? 1 : 0);
  return [...grouped(items, segmentOf)]
    .map(([name, list]) => ({ name, items: list }))
    .sort((a, b) => last(a.name) - last(b.name) || b.items.length - a.items.length || a.name.localeCompare(b.name));
}

/** The tables a query names, in schema order. */
function tablesIn(tables: SchemaTable[], text: string): SchemaTable[] {
  const words = new Set(text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
  return tables.filter((t) => words.has(t.name));
}

function typeOf(c: SchemaColumn): string {
  if (c.collection) {
    return 'dynamic[]';
  }
  return c.complexType ? 'dynamic' : c.type;
}

function describe(name: string, description: string): string {
  return description ? `${name}: ${description}` : name;
}

/** A function's call as the panel shows it and its hover text, with each parameter's type. */
const signature = (f: SchemaFunction) => `${f.name}(${f.parameters.map((p) => `${p.name}: ${p.type}`).join(', ')})`;

/** Each source's panel heading, as the mockups name them. */
const TITLES: Record<Source, string> = {
  graph: 'Schema',
  raw: 'Schema',
  hunting: 'Advanced hunting schema',
  arg: 'Resource Graph tables',
};

interface SchemaPanelProps {
  /** The active tab's source: its tables, plus advanced hunting's functions or Resource Graph's resource types. */
  source?: Source;
  /** The source's schema; undefined while it is read (or when it couldn't be). */
  schema: SchemaView | null | undefined;
  /** Why the schema couldn't be read. */
  error?: string;
  /** The account's Resource Graph resource types (`arm.resourceTypes`), why they couldn't be listed, and what helps. */
  resourceTypes?: string[];
  resourceTypesError?: string | null;
  resourceTypesFix?: ResourceTypesFix;
  /** The active account, which "Grant Azure access" asks consent for. */
  accountKey?: string;
  /** Opens sign-in, when listing the resource types needs the account to sign in again. */
  onSignIn?: () => void;
  /** The active tab's query, for "In this query". */
  text: string;
  onInsert: (name: string) => void;
}

/** The left panel for the active tab's source (spec 6.1): the schema tree with search; descriptions show on hover. Advanced
 * hunting adds its functions and Resource Graph the account's resource types, which the search finds too. */
export function SchemaPanel(props: SchemaPanelProps) {
  const { source = 'graph', schema, error, resourceTypes, resourceTypesError, resourceTypesFix, accountKey, onSignIn, text, onInsert } = props;
  const [query, setQuery] = useState('');
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  /** A new search opens every matching area again: the areas opened or closed for the last one are forgotten. */
  const changeQuery = (next: string) => {
    setQuery(next);
    setToggled((t) => Object.fromEntries(Object.entries(t).filter(([key]) => !key.startsWith('find-area:'))));
  };
  const tables = useMemo(() => schema?.tables ?? [], [schema]);
  const inQuery = useMemo(() => tablesIn(tables, text), [tables, text]);
  const found = useMemo(() => (query.trim() ? search(tables, query) : null), [tables, query]);
  const needle = query.trim().toLowerCase();
  const functions = (schema?.functions ?? []).filter((f) => !needle || f.name.toLowerCase().includes(needle));
  const types = source === 'arg' ? (resourceTypes ?? []).filter((t) => !needle || t.toLowerCase().includes(needle)) : [];
  const title = TITLES[source];

  const toggle = (key: string, open: boolean) => setToggled((t) => ({ ...t, [key]: !open }));
  // Graph's tables carry their data area; advanced hunting's and Resource Graph's don't, and stay a flat list.
  const byAreas = tables.some((t) => Boolean(t.area));

  const renderTable = (key: string, table: SchemaTable, columns: SchemaColumn[], openByDefault: boolean) => {
    const open = toggled[key] ?? openByDefault;
    // A nested Graph table's path (auditLogs/signIns) follows its name in faint text and in the hover text, since a narrow
    // panel truncates it first.
    const path = table.path && table.path !== table.name ? table.path : null;
    return (
      <li key={key}>
        <button
          type="button"
          aria-expanded={open}
          title={describe(path ? `${table.name} (${path})` : table.name, table.description)}
          onClick={() => toggle(key, open)}
          onDoubleClick={() => onInsert(table.name)}
        >
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span className="mono truncate" style={{ color: open ? 'var(--tbl)' : undefined }}>
            {table.name}
          </span>
          {path && <span className="faint mono truncate text-[11px] shrink-[100]">{path}</span>}
          <span className="ty">{table.columns.length} columns</span>
        </button>
        {open && (
          <ul className="m-0 list-none p-0">
            {columns.map((c) => (
              <li key={c.name}>
                <button type="button" className="col mono" title={describe(c.name, c.description)} onClick={() => onInsert(c.name)}>
                  <span className="truncate">{c.name}</span>
                  {c.filterable === true && (
                    <span className="tag" title="Graph filters on this">
                      filter
                    </span>
                  )}
                  {c.listable === false && (
                    <span className="tag warn" title="Read one object at a time">
                      per object
                    </span>
                  )}
                  <span className="ty">{typeOf(c)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </li>
    );
  };

  /** A collapsible area or subgroup row, with its table count. */
  const renderGroup = (key: string, name: string, count: number, openByDefault: boolean, children: () => ReactNode) => {
    const open = toggled[key] ?? openByDefault;
    return (
      <li key={key}>
        <button type="button" className="group" aria-expanded={open} onClick={() => toggle(key, open)}>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span className="truncate">{name}</span>
          <span className="ty">{count.toLocaleString('en-US')}</span>
        </button>
        {open && (
          <ul className="schema-tree" aria-label={name}>
            {children()}
          </ul>
        )}
      </li>
    );
  };

  /** The tables of "All tables" or "Matches": by area for Graph (areas and subgroups open when `groupsOpen`), else flat. */
  const renderTables = (prefix: string, items: Listed[], groupsOpen: boolean) => {
    const rows = (list: Listed[]) => list.map((i) => renderTable(`${prefix}:${i.table.name}`, i.table, i.columns, i.open));
    if (!byAreas) {
      return rows(items);
    }
    return byArea(items).map((area) =>
      renderGroup(`${prefix}-area:${area.name}`, area.name, area.items.length, groupsOpen, () =>
        area.name === SPLIT_AREA
          ? bySegment(area.items).map((segment) =>
              renderGroup(`${prefix}-area:${area.name}/${segment.name}`, segment.name, segment.items.length, groupsOpen, () =>
                rows(segment.items),
              ),
            )
          : rows(area.items),
      ),
    );
  };

  const all = useMemo(() => tables.map((table): Listed => ({ table, columns: table.columns, open: false })), [tables]);

  return (
    <aside className="side" aria-label={title}>
      <h2>{title}</h2>
      <input
        className="search"
        type="search"
        aria-label="Find a table or column"
        placeholder={schema ? `Find among ${tables.length.toLocaleString('en-US')} tables` : error ? 'No schema' : 'Loading the schema…'}
        value={query}
        onChange={(e) => changeQuery(e.target.value)}
        disabled={!schema}
      />
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {error && !schema && (
          <p role="alert" className="m-0 px-[14px] pb-2 text-[12px] text-bad">
            The schema couldn’t be loaded: {error}
          </p>
        )}
        {found ? (
          <>
            <h2 className="pt-1">Matches</h2>
            {found.length === 0 && functions.length === 0 && types.length === 0 ? (
              <p className="faint m-0 px-[14px] text-[12px]">No table or column matches.</p>
            ) : (
              <ul className="schema-tree" aria-label="Matches">
                {renderTables('find', found, true)}
              </ul>
            )}
          </>
        ) : (
          <>
            {inQuery.length > 0 && (
              <>
                <h2 className="pt-1">In this query</h2>
                <ul className="schema-tree" aria-label="In this query">
                  {inQuery.map((t) => renderTable(`query:${t.name}`, t, t.columns, true))}
                </ul>
              </>
            )}
            <h2>All tables</h2>
            <ul className="schema-tree" aria-label="All tables">
              {renderTables('all', all, false)}
            </ul>
          </>
        )}
        {functions.length > 0 && (
          <>
            <h2>Functions</h2>
            <ul className="schema-tree" aria-label="Functions">
              {functions.map((f) => (
                <li key={f.name}>
                  <button type="button" className="col mono" title={describe(signature(f), f.description)} onClick={() => onInsert(f.name)}>
                    <span className="truncate" style={{ color: 'var(--tbl)' }}>
                      {f.name}
                    </span>
                    <span className="ty truncate">({f.parameters.map((p) => p.name).join(', ')})</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {source === 'arg' && (
          <>
            <h2>Resource types</h2>
            {resourceTypesError && !resourceTypes ? (
              <div className="flex flex-wrap items-center gap-2 px-[14px] text-[12px]">
                <p className="faint m-0 min-w-0">{resourceTypesError}</p>
                {resourceTypesFix === 'consent' && <ConsentButton accountKey={accountKey} />}
                {resourceTypesFix === 'signIn' && onSignIn && (
                  <button type="button" className="btn primary shrink-0" onClick={onSignIn}>
                    Sign in
                  </button>
                )}
              </div>
            ) : !resourceTypes ? (
              <p className="faint m-0 px-[14px] text-[12px]">Listing your resource types…</p>
            ) : types.length === 0 ? (
              <p className="faint m-0 px-[14px] text-[12px]">{needle ? 'No resource type matches.' : 'No resources found.'}</p>
            ) : (
              <ul className="schema-tree" aria-label="Resource types">
                {types.map((t) => (
                  <li key={t}>
                    <button type="button" className="col mono" title={`Insert "${t}"`} onClick={() => onInsert(`"${t}"`)}>
                      <span className="truncate">{t}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      {source === 'arg' && <div className="side-foot faint text-[11.5px]">properties and tags are dynamic; the types come from your resources.</div>}
    </aside>
  );
}
