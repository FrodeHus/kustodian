import { useState } from 'react';

const isNode = (value: unknown): value is Record<string, unknown> | unknown[] => typeof value === 'object' && value !== null;

const entriesOf = (value: Record<string, unknown> | unknown[]): [string, unknown][] =>
  Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value);

/** What a closed node holds: `{3 keys}`, `[2 items]`. */
const summary = (value: Record<string, unknown> | unknown[]) => {
  const n = entriesOf(value).length;
  return Array.isArray(value) ? `[${n} ${n === 1 ? 'item' : 'items'}]` : `{${n} ${n === 1 ? 'key' : 'keys'}}`;
};

/** A leaf as JSON writes it, coloured like the editor: strings, numbers, booleans and null. */
function Leaf({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-faint">null</span>;
  }
  if (typeof value === 'string') {
    return <span className="jtree-str">{JSON.stringify(value)}</span>;
  }
  if (typeof value === 'number') {
    return <span className="jtree-num">{value}</span>;
  }
  if (typeof value === 'boolean') {
    return <span className="jtree-bool">{String(value)}</span>;
  }
  if (isNode(value)) {
    return <span className="text-muted">{Array.isArray(value) ? '[]' : '{}'}</span>;
  }
  return <span>{JSON.stringify(value)}</span>;
}

function Key({ name, index }: { name: string; index: boolean }) {
  return <span className={index ? 'text-faint' : 'jtree-key'}>{index ? name : JSON.stringify(name)}</span>;
}

function Entry({ name, index, value, depth, openDepth }: { name: string; index: boolean; value: unknown; depth: number; openDepth: number }) {
  const [open, setOpen] = useState(depth < openDepth);
  if (!isNode(value) || entriesOf(value).length === 0) {
    return (
      <li className="jtree-leaf">
        <Key name={name} index={index} />
        <span className="text-faint">: </span>
        <Leaf value={value} />
      </li>
    );
  }
  return (
    <li>
      <button type="button" className="jtree-toggle" aria-label={`${name}: ${summary(value)}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden="true" className="jtree-caret">
          {open ? '▾' : '▸'}
        </span>
        <Key name={name} index={index} />
        <span className="text-faint">: </span>
        <span className="text-muted">{summary(value)}</span>
      </button>
      {open && <Entries value={value} depth={depth + 1} openDepth={openDepth} />}
    </li>
  );
}

function Entries({ value, depth, openDepth }: { value: Record<string, unknown> | unknown[]; depth: number; openDepth: number }) {
  const index = Array.isArray(value);
  return (
    <ul className="jtree-list">
      {entriesOf(value).map(([name, v]) => (
        <Entry key={name} name={name} index={index} value={v} depth={depth} openDepth={openDepth} />
      ))}
    </ul>
  );
}

/**
 * A dynamic value as a tree: each object or array is a disclosure button (Enter or Space opens and closes it) over its entries,
 * and closed ones say how many they hold. Nodes shallower than `openDepth` start open.
 */
export function JsonTree({ value, label, openDepth = 1 }: { value: Record<string, unknown> | unknown[]; label: string; openDepth?: number }) {
  return (
    <div className="jtree" role="group" aria-label={label}>
      {entriesOf(value).length === 0 ? <Leaf value={value} /> : <Entries value={value} depth={0} openDepth={openDepth} />}
    </div>
  );
}
