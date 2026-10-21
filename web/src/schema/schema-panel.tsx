import { useMemo, useState } from 'react';
import type { SchemaColumn, SchemaTable, SchemaView } from '../wire';

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

interface SchemaPanelProps {
  schema: SchemaView | null;
  /** The active tab's query, for "In this query". */
  text: string;
  onInsert: (name: string) => void;
}

/** The left panel for a Graph tab (spec 6.1): the schema tree with search; descriptions show on hover. */
export function SchemaPanel({ schema, text, onInsert }: SchemaPanelProps) {
  const [query, setQuery] = useState('');
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const tables = useMemo(() => schema?.tables ?? [], [schema]);
  const inQuery = useMemo(() => tablesIn(tables, text), [tables, text]);
  const found = useMemo(() => (query.trim() ? search(tables, query) : null), [tables, query]);

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
                  {c.filterable && (
                    <span className="tag" title="Graph filters on this">
                      filter
                    </span>
                  )}
                  {!c.listable && (
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
    <aside className="side" aria-label="Schema">
      <h2>Schema</h2>
      <input
        className="search"
        type="search"
        aria-label="Find a table or column"
        placeholder={schema ? `Find among ${tables.length.toLocaleString('en-US')} tables` : 'Loading the schema…'}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        disabled={!schema}
      />
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {found ? (
          <>
            <h2 className="pt-1">Matches</h2>
            {found.length === 0 ? (
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
      </div>
    </aside>
  );
}
