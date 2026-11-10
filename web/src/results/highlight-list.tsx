import { useId, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { newId } from '../shell/ids';
import type { HighlightColour, HighlightRule, ResultColumn } from '../wire';
import { HIGHLIGHT_COLOURS, HIGHLIGHT_OPS, MAX_HIGHLIGHTS, ruleProblem } from './highlights';

const COLOUR_NAME: Record<HighlightColour, string> = { danger: 'Danger', warning: 'Warning', success: 'Success', info: 'Info' };
const NO_VALUE = new Set(['isempty', 'isnotempty']);

/** The colour and row/cell selects, shared with the popover that makes a rule from a cell. */
export function ColourTarget({
  rule,
  disabled,
  onChange,
}: {
  rule: HighlightRule;
  disabled?: boolean;
  onChange: (patch: Partial<HighlightRule>) => void;
}) {
  return (
    <>
      <select
        className="textbox"
        aria-label="Colour"
        value={rule.colour}
        disabled={disabled}
        onChange={(e) => onChange({ colour: e.target.value as HighlightColour })}
      >
        {HIGHLIGHT_COLOURS.map((c) => (
          <option key={c} value={c}>
            {COLOUR_NAME[c]}
          </option>
        ))}
      </select>
      <select
        className="textbox"
        aria-label="Applies to"
        value={rule.target}
        disabled={disabled}
        onChange={(e) => onChange({ target: e.target.value as HighlightRule['target'] })}
      >
        <option value="row">Row</option>
        <option value="cell">Cell</option>
      </select>
    </>
  );
}

/**
 * A query's highlight rules, first match wins: each rule's colour, column (any text, the result's columns offered), operator,
 * value and row or cell, reordered with Move up / Move down or Alt+Up / Alt+Down. Every change goes to `onChange` at once.
 */
export function HighlightList({
  rules,
  columns,
  onChange,
  readOnly = false,
}: {
  rules: HighlightRule[];
  columns: ResultColumn[];
  onChange: (rules: HighlightRule[]) => void;
  readOnly?: boolean;
}) {
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  // The moved rule and the control (by name) to focus after the move: React moves its row, which can drop focus, and a move
  // button that is now disabled can't keep it. Then its other move button, or the rule's first control, takes it.
  const refocus = useRef<{ id: string; control: string } | null>(null);
  useLayoutEffect(() => {
    const want = refocus.current;
    refocus.current = null;
    const group = want && [...(list.current?.querySelectorAll<HTMLElement>('[data-rule]') ?? [])].find((g) => g.dataset.rule === want.id);
    if (!group) return;
    const other = want.control === 'Move up' ? 'Move down' : 'Move up';
    const pick = (sel: string) => group.querySelector<HTMLElement>(`${sel}:not(:disabled)`);
    (pick(`[aria-label="${want.control}"]`) ?? pick(`[aria-label="${other}"]`) ?? pick('select, input, button'))?.focus();
  }, [rules]);

  const set = (i: number, patch: Partial<HighlightRule>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i: number, to: number, control: string) => {
    if (to < 0 || to >= rules.length) return;
    refocus.current = { id: rules[i]!.id, control };
    const next = [...rules];
    [next[i], next[to]] = [next[to]!, next[i]!];
    onChange(next);
  };
  const onKey = (e: KeyboardEvent, i: number) => {
    if (readOnly || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const control = document.activeElement instanceof HTMLElement ? (document.activeElement.getAttribute('aria-label') ?? '') : '';
    move(i, e.key === 'ArrowUp' ? i - 1 : i + 1, control);
  };
  const full = rules.length >= MAX_HIGHLIGHTS;

  return (
    <div ref={list} className="flex flex-col gap-2 text-[12px]">
      <datalist id={listId}>
        {columns.map((c) => (
          <option key={c.name} value={c.name} />
        ))}
      </datalist>
      {rules.map((rule, i) => {
        const problem = ruleProblem(rule, columns);
        const type = columns.find((c) => c.name === rule.column)?.type;
        return (
          <div
            key={rule.id}
            role="group"
            aria-label={`Rule ${i + 1}`}
            data-rule={rule.id}
            className="flex flex-col gap-1"
            onKeyDown={(e) => onKey(e, i)}
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <ColourTarget rule={rule} disabled={readOnly} onChange={(patch) => set(i, patch)} />
              <input
                className="textbox mono w-[140px]"
                aria-label="Column"
                list={listId}
                value={rule.column}
                disabled={readOnly}
                onChange={(e) => set(i, { column: e.target.value })}
              />
              <select
                className="textbox mono"
                aria-label="Operator"
                value={rule.op}
                disabled={readOnly}
                onChange={(e) => {
                  const op = e.target.value as HighlightRule['op'];
                  set(i, NO_VALUE.has(op) ? { op, value: '' } : { op });
                }}
              >
                {HIGHLIGHT_OPS.map((op) => (
                  <option key={op} value={op}>
                    {op}
                  </option>
                ))}
              </select>
              {!NO_VALUE.has(rule.op) && (
                <input
                  className="textbox mono w-[140px]"
                  aria-label="Value"
                  value={rule.value}
                  disabled={readOnly}
                  onChange={(e) => set(i, { value: e.target.value })}
                />
              )}
              <button
                type="button"
                className="btn ghost"
                aria-label="Move up"
                disabled={readOnly || i === 0}
                onClick={() => move(i, i - 1, 'Move up')}
              >
                ↑
              </button>
              <button
                type="button"
                className="btn ghost"
                aria-label="Move down"
                disabled={readOnly || i === rules.length - 1}
                onClick={() => move(i, i + 1, 'Move down')}
              >
                ↓
              </button>
              <button
                type="button"
                className="btn ghost"
                aria-label="Remove"
                disabled={readOnly}
                onClick={() => onChange(rules.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
            {problem && <span className="faint">{problem === 'missing' ? 'Not in this result' : `Can’t read this value as ${type}`}</span>}
          </div>
        );
      })}
      <div>
        <button
          type="button"
          className="btn ghost"
          disabled={readOnly || full}
          title={full ? `Up to ${MAX_HIGHLIGHTS} rules` : undefined}
          onClick={() =>
            onChange([...rules, { id: newId(), column: columns[0]?.name ?? '', op: '==', value: '', colour: 'danger', target: 'row' }])
          }
        >
          + Add rule
        </button>
      </div>
    </div>
  );
}
