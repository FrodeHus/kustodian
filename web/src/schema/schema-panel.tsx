import { useMemo, useState } from 'react';
import type { SchemaColumn, SchemaFunction, SchemaTable, SchemaView, Source } from '../wire';

interface Listed {
  table: SchemaTable;
  columns: SchemaColumn[];
  /** Opened because the search matched its columns rather than its name. */
  open: boolean;
}

/** Tables whose name matches the search with all their columns, and tables with matching columns opened on just those. */
function search(tables: SchemaTable[], text: string): Listed[] {
  const needle = text.trim().toLowerCase();
  return tables.flatMap((table): Listed[] => {
    if (table.name.toLowerCase().includes(needle)) {
      return [{ table, columns: table.columns, open: false }];
    }
    const columns = table.columns.filter((c) => c.name.toLowerCase().includes(needle));
    return columns.length > 0 ? [{ table, columns, open: true }] : [];
  });
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
  /** The account's Resource Graph resource types (`arm.resourceTypes`), and why they couldn't be listed. */
  resourceTypes?: string[];
  resourceTypesError?: string | null;
  /** The active tab's query, for "In this query". */
  text: string;
  onInsert: (name: string) => void;
}

/** The left panel for the active tab's source (spec 6.1): the schema tree with search; descriptions show on hover. Advanced
 * hunting adds its functions and Resource Graph the account's resource types, which the search finds too. */
export function SchemaPanel({ source = 'graph', schema, error, resourceTypes, resourceTypesError, text, onInsert }: SchemaPanelProps) {
  const [query, setQuery] = useState('');
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const tables = useMemo(() => schema?.tables ?? [], [schema]);
  const inQuery = useMemo(() => tablesIn(tables, text), [tables, text]);
  const found = useMemo(() => (query.trim() ? search(tables, query) : null), [tables, query]);
  const needle = query.trim().toLowerCase();
  const functions = (schema?.functions ?? []).filter((f) => !needle || f.name.toLowerCase().includes(needle));
  const types = source === 'arg' ? (resourceTypes ?? []).filter((t) => !needle || t.toLowerCase().includes(needle)) : [];
  const title = TITLES[source];

  const toggle = (key: string, open: boolean) => setToggled((t) => ({ ...t, [key]: !open }));

  const renderTable = (key: string, table: SchemaTable, columns: SchemaColumn[], openByDefault: boolean) => {
    const open = toggled[key] ?? openByDefault;
    return (
      <li key={key}>
        <button
          type="button"
          aria-expanded={open}
          title={describe(table.name, table.description)}
          onClick={() => toggle(key, open)}
          onDoubleClick={() => onInsert(table.name)}
        >
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span className="mono truncate" style={{ color: open ? 'var(--tbl)' : undefined }}>
            {table.name}
          </span>
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

  return (
    <aside className="side" aria-label={title}>
      <h2>{title}</h2>
      <input
        className="search"
        type="search"
        aria-label="Find a table or column"
        placeholder={schema ? `Find among ${tables.length.toLocaleString('en-US')} tables` : error ? 'No schema' : 'Loading the schema…'}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
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
              <ul className="schema-tree">{found.map((f) => renderTable(`find:${f.table.name}`, f.table, f.columns, f.open))}</ul>
            )}
          </>
        ) : (
          <>
            {inQuery.length > 0 && (
              <>
                <h2 className="pt-1">In this query</h2>
                <ul className="schema-tree">{inQuery.map((t) => renderTable(`query:${t.name}`, t, t.columns, true))}</ul>
              </>
            )}
            <h2>All tables</h2>
            <ul className="schema-tree">{tables.map((t) => renderTable(`all:${t.name}`, t, t.columns, false))}</ul>
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
              <p className="faint m-0 px-[14px] text-[12px]">{resourceTypesError}</p>
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
