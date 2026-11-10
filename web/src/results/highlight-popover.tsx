import { useState } from 'react';
import type { HighlightRule, ResultColumn } from '../wire';
import { ColourTarget, HighlightList } from './highlight-list';
import { ruleFromCell } from './highlights';
import { Popover } from './popover';
import { quotedValue } from './smart-filter';

/** "Highlight rows where …": the rule a cell prefills, with its colour and row or cell to pick, then Add. */
export function HighlightFromCell({
  column,
  value,
  at,
  onAdd,
  onClose,
}: {
  column: ResultColumn;
  value: unknown;
  at?: { x: number; y: number };
  onAdd: (rule: HighlightRule) => void;
  onClose: (refocus: boolean) => void;
}) {
  const [rule, setRule] = useState(() => ruleFromCell(column, value));
  const text = rule.op === 'isempty' ? `${column.name} is empty` : `${column.name} == ${quotedValue(column, value)}`;
  return (
    <Popover label={`Highlight rows where ${text}`} at={at} className="w-[300px]" onClose={onClose}>
      <div>
        Highlight rows where <b className="mono">{text}</b>
      </div>
      <div className="flex items-center gap-1.5">
        <ColourTarget rule={rule} onChange={(patch) => setRule({ ...rule, ...patch })} />
        <div className="grow" />
        <button type="button" className="btn" onClick={() => onAdd(rule)}>
          Add
        </button>
      </div>
    </Popover>
  );
}

/** The rule list in a popover: `Highlight rules`. */
export function HighlightListPopover({
  at,
  onClose,
  ...list
}: {
  rules: HighlightRule[];
  columns: ResultColumn[];
  onChange: (rules: HighlightRule[]) => void;
  at?: { x: number; y: number };
  onClose: (refocus: boolean) => void;
}) {
  return (
    <Popover label="Highlight rules" at={at} className="w-[640px]" onClose={onClose}>
      <b>Highlight rules</b>
      <HighlightList {...list} />
    </Popover>
  );
}
