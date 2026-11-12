import type { ReactNode } from 'react';
import type { Better, Picked } from './chart-shape';
import { gaugeRange } from './gauge-shape';

/** Without `key`, so a cleared field leaves the pick unset. */
const without = (picked: Picked, key: 'target' | 'min' | 'max'): Picked => {
  const rest = { ...picked };
  delete rest[key];
  return rest;
};

/**
 * A gauge's own pickers: desired level, direction, and the scale's min and max. `inline` is the Chart tab's label-and-input
 * row; `field` is the widget editor's stacked `.field`.
 */
export function GaugeFields({
  picked,
  onChange,
  layout,
}: {
  picked: Picked;
  onChange: (picked: Picked) => void;
  layout: 'inline' | 'field';
}) {
  const { valid } = gaugeRange(picked);
  const wrap = (name: string, control: ReactNode) =>
    layout === 'field' ? (
      <label className="field">
        <span>{name}</span>
        {control}
      </label>
    ) : (
      <label className="flex items-center gap-2">
        <span className="muted">{name}</span>
        {control}
      </label>
    );
  const style = layout === 'inline' ? { height: 28, width: 90 } : undefined;
  const number = (name: string, key: 'target' | 'min' | 'max', invalid = false) =>
    wrap(
      name,
      <input
        type="number"
        className="textbox"
        style={style}
        aria-label={name}
        aria-invalid={invalid ? true : undefined}
        value={picked[key] ?? ''}
        onChange={(e) => {
          const { value, validity } = e.currentTarget;
          if (value === '') {
            // A half-typed "-" is empty but not cleared: leave the pick alone.
            if (!validity.badInput) {
              onChange(without(picked, key));
            }
          } else if (Number.isFinite(Number(value))) {
            onChange({ ...picked, [key]: Number(value) });
          }
        }}
      />,
    );

  return (
    <>
      {number('Desired level', 'target')}
      {wrap(
        'Direction',
        <select
          className="textbox"
          style={layout === 'inline' ? { height: 28 } : undefined}
          aria-label="Direction"
          value={picked.better ?? 'higher'}
          onChange={(e) => onChange({ ...picked, better: e.target.value as Better })}
        >
          <option value="higher">Higher is better</option>
          <option value="lower">Lower is better</option>
        </select>,
      )}
      {number('Min', 'min', !valid)}
      {number('Max', 'max', !valid)}
    </>
  );
}
