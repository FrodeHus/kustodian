import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Gauge, GaugeData } from './gauge-shape';
import GaugeView from './gauge-view';

const gauge = (key: string, value: number | null, good: boolean | null, fill = 0.72): Gauge => ({
  key,
  label: key,
  value,
  text: value === null ? '–' : String(value),
  fill,
  good,
  aria: `${key}: ${value}`,
});
const data = (over: Partial<GaugeData> = {}): GaugeData => ({
  gauges: [gauge('Contoso', 72, true), gauge('Fabrikam', 40, false, 0.4), gauge('Adatum', null, null, 0)],
  total: 3,
  labelColumn: 'tenant',
  valueColumn: 'score',
  target: 80,
  targetFill: 0.8,
  better: 'higher',
  min: 0,
  max: 100,
  ...over,
});
const arc = (el: HTMLElement) => el.querySelector<SVGElement>('[data-testid="gauge-arc"]');

describe('GaugeView', () => {
  it('gauge_view_shows_value_target_and_colours', () => {
    render(<GaugeView data={data()} onPick={vi.fn()} animate={false} />);
    const [a, b, c] = screen.getAllByRole('button');
    expect(a!.getAttribute('aria-label')).toBe('Contoso: 72');
    expect(a!.textContent).toContain('72');
    expect(a!.textContent).toContain('desired 80');
    expect(arc(a!)!.getAttribute('stroke')).toBe('var(--ok)');
    expect(arc(b!)!.getAttribute('stroke')).toBe('var(--bad)');
    expect(arc(c!)).toBeNull();
    expect(c!.textContent).toContain('–');
    expect(a!.querySelector('[data-testid="gauge-tick"]')).not.toBeNull();
  });

  it('gauge_view_without_target_uses_accent_and_no_tick', () => {
    render(
      <GaugeView
        data={data({ target: undefined, targetFill: undefined, gauges: [gauge('A', 5, null)] })}
        onPick={vi.fn()}
        animate={false}
      />,
    );
    const g = screen.getByRole('button');
    expect(arc(g)!.getAttribute('stroke')).toBe('var(--accent)');
    expect(g.textContent).not.toContain('desired');
    expect(g.querySelector('[data-testid="gauge-tick"]')).toBeNull();
  });

  it('gauge_view_click_and_enter_pick_the_label', () => {
    const onPick = vi.fn();
    render(<GaugeView data={data()} onPick={onPick} animate={false} />);
    const first = screen.getAllByRole('button')[0]!;
    fireEvent.click(first);
    fireEvent.keyDown(first, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledTimes(2);
    expect(onPick).toHaveBeenLastCalledWith([{ id: 'tenant', value: 'Contoso' }]);
  });

  it('gauge_view_without_label_column_is_not_clickable', () => {
    const onPick = vi.fn();
    render(<GaugeView data={data({ labelColumn: null })} onPick={onPick} animate={false} />);
    expect(screen.queryByRole('button')).toBeNull();
    const groups = screen.getAllByRole('group');
    expect(groups).toHaveLength(3);
    fireEvent.click(groups[0]!);
    fireEvent.keyDown(groups[0]!, { key: 'Enter' });
    expect(onPick).not.toHaveBeenCalled();
  });

  it('gauge_view_arrows_home_end_move_focus', () => {
    render(<GaugeView data={data()} onPick={vi.fn()} animate={false} />);
    const [a, b, c] = screen.getAllByRole('button');
    expect([a, b, c].map((g) => g!.tabIndex)).toEqual([0, -1, -1]);
    a!.focus();
    fireEvent.keyDown(a!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(b);
    fireEvent.keyDown(b!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(b);
    fireEvent.keyDown(b!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(a!, { key: 'End' });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c!, { key: 'Home' });
    expect(document.activeElement).toBe(a);
  });

  it('gauge_view_shows_readout_on_hover', () => {
    render(<GaugeView data={data({ better: 'lower' })} onPick={vi.fn()} animate={false} />);
    fireEvent.mouseOver(screen.getAllByRole('button')[0]!);
    const tip = screen.getByTestId('gauge-tip');
    expect(tip.textContent).toContain('Contoso');
    expect(tip.textContent).toContain('score: 72');
    expect(tip.textContent).toContain('desired 80 · lower is better');
  });

  it('gauge_view_renders_the_note_above_the_gauges', () => {
    render(<GaugeView data={data({ note: 'Showing 24 of 30 rows.' })} onPick={vi.fn()} animate={false} />);
    const note = screen.getByText('Showing 24 of 30 rows.');
    expect(note.compareDocumentPosition(screen.getAllByRole('button')[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('gauge_view_centres_a_single_gauge_up_to_260px', () => {
    render(<GaugeView data={data({ gauges: [gauge('A', 5, null)] })} onPick={vi.fn()} animate={false} />);
    const grid = screen.getByRole('button').parentElement!;
    expect(grid.style.gridTemplateColumns).toBe('minmax(130px, 260px)');
    expect(grid.style.justifyContent).toBe('center');
    expect(grid.style.padding).toBe('4px');
  });

  it('gauge_view_without_onpick_renders_groups_not_buttons', () => {
    render(<GaugeView data={data()} animate={false} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getAllByRole('group').length).toBeGreaterThan(0);
  });
});
