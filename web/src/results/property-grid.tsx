import { useState } from 'react';

type Node = Record<string, unknown> | unknown[];

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null;

const entriesOf = (value: Node): [string, unknown][] =>
  Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value);

/** What a closed node holds: `{3 keys}`, `[2 items]`. */
const summary = (value: Node) => {
  const n = entriesOf(value).length;
  return Array.isArray(value) ? `[${n} ${n === 1 ? 'item' : 'items'}]` : `{${n} ${n === 1 ? 'key' : 'keys'}}`;
};

/** An object's name, to tell array items apart while they're closed: its displayName, name or id, else its first text value. */
const hint = (value: Node) => {
  if (Array.isArray(value)) {
    return undefined;
  }
  const named = ['displayName', 'name', 'id'].map((k) => value[k]).find((v) => typeof v === 'string' && v !== '');
  return (named ?? Object.values(value).find((v) => typeof v === 'string' && v !== '')) as string | undefined;
};

/** A leaf, coloured like the editor: strings (without quotes, as a property grid shows them), numbers, booleans and null. */
function Leaf({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-faint">null</span>;
  }
  if (typeof value === 'string') {
    return value === '' ? <span className="text-faint">""</span> : <span className="pgrid-str">{value}</span>;
  }
  if (typeof value === 'number') {
    return <span className="pgrid-num">{value}</span>;
  }
  if (typeof value === 'boolean') {
    return <span className="pgrid-bool">{String(value)}</span>;
  }
  if (isNode(value)) {
    return <span className="text-faint">{Array.isArray(value) ? '[]' : '{}'}</span>;
  }
  return <span>{JSON.stringify(value)}</span>;
}

function Row({ name, index, value, depth, openDepth }: { name: string; index: boolean; value: unknown; depth: number; openDepth: number }) {
  const [open, setOpen] = useState(depth < openDepth);
  const node = isNode(value) && entriesOf(value).length > 0;
  const key = index ? `[${name}]` : name;
  return (
    <>
      <tr>
        <th scope="row" title={key} style={{ paddingLeft: 6 + depth * 14 }}>
          {node ? (
            <button
              type="button"
              className="pgrid-toggle"
              aria-label={`${name}: ${summary(value)}`}
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              <span aria-hidden="true" className="pgrid-caret">
                {open ? '▾' : '▸'}
              </span>
              {key}
            </button>
          ) : (
            <>
              <span aria-hidden="true" className="pgrid-caret" />
              {key}
            </>
          )}
        </th>
        <td>
          {node ? (
            <span className="text-faint">
              {summary(value)}
              {!open && hint(value) && <span className="text-muted"> · {hint(value)}</span>}
            </span>
          ) : (
            <Leaf value={value} />
          )}
        </td>
      </tr>
      {node && open && <Rows value={value} depth={depth + 1} openDepth={openDepth} />}
    </>
  );
}

function Rows({ value, depth, openDepth }: { value: Node; depth: number; openDepth: number }) {
  const index = Array.isArray(value);
  return entriesOf(value).map(([name, v]) => <Row key={name} name={name} index={index} value={v} depth={depth} openDepth={openDepth} />);
}

/**
 * A dynamic value as a property grid: a key and a value on each row. Each object or array is a disclosure button (Enter or
 * Space opens and closes it) whose entries show indented below it; closed ones say how many they hold. Nodes shallower than
 * `openDepth` start open.
 */
export function PropertyGrid({ value, label, openDepth = 1 }: { value: Node; label: string; openDepth?: number }) {
  return (
    <div className="pgrid" role="group" aria-label={label}>
      {entriesOf(value).length === 0 ? (
        <Leaf value={value} />
      ) : (
        <table>
          <tbody>
            <Rows value={value} depth={0} openDepth={openDepth} />
          </tbody>
        </table>
      )}
    </div>
  );
}
