import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Picked } from './chart-shape';
import { GaugeFields } from './gauge-fields';

function Harness({ initial = {}, onChange }: { initial?: Picked; onChange: (p: Picked) => void }) {
  const [picked, setPicked] = useState<Picked>(initial);
  return (
    <GaugeFields
      picked={picked}
      layout="inline"
      onChange={(p) => {
        onChange(p);
        setPicked(p);
      }}
    />
  );
}

describe('GaugeFields', () => {
  it('gauge_fields_sets_and_clears_the_target', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByLabelText('Desired level');
    fireEvent.change(input, { target: { value: '80' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ target: 80 }));
    fireEvent.change(input, { target: { value: '' } });
    const last = onChange.mock.calls.at(-1)![0] as Picked;
    expect('target' in last && last.target !== undefined).toBe(false);
  });

  it('gauge_fields_ignores_a_lone_minus', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    // jsdom reads a bare "-" in a number input as '' (like a browser, which also flags badInput).
    fireEvent.change(screen.getByLabelText('Desired level'), { target: { value: '-' } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('gauge_fields_picks_a_direction', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Direction'), { target: { value: 'lower' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ better: 'lower' }));
    expect(screen.getByRole('option', { name: 'Higher is better' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Lower is better' })).toBeTruthy();
  });

  it('gauge_fields_marks_min_not_below_max_invalid', () => {
    render(<Harness initial={{ min: 50, max: 50 }} onChange={vi.fn()} />);
    expect(screen.getByLabelText('Min').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText('Max').getAttribute('aria-invalid')).toBe('true');
  });

  it('gauge_fields_leaves_a_valid_range_unmarked', () => {
    render(<Harness initial={{ min: 0, max: 10 }} onChange={vi.fn()} />);
    expect(screen.getByLabelText('Min').getAttribute('aria-invalid')).toBeNull();
  });
});
