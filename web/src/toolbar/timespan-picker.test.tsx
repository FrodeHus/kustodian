import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TimespanPicker } from './timespan-picker';

function Picker({ initial = null, onChange }: { initial?: string | null; onChange: (timespan: string) => void }) {
  const [timespan, setTimespan] = useState<string | null>(initial);
  const [open, setOpen] = useState(false);
  return (
    <>
      <TimespanPicker
        timespan={timespan}
        open={open}
        onOpenChange={setOpen}
        onChange={(t) => {
          setTimespan(t);
          onChange(t);
        }}
      />
      <button type="button">Elsewhere</button>
    </>
  );
}

describe('TimespanPicker', () => {
  it('timespan_picker_offers_1_7_and_30_days_with_30_by_default', () => {
    const onChange = vi.fn();
    render(<Picker onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: 'Timespan: 30 days' });

    fireEvent.click(trigger);
    expect(screen.getAllByRole('menuitemradio').map((b) => [b.textContent, b.getAttribute('aria-checked')])).toEqual([
      ['1 day', 'false'],
      ['7 days', 'false'],
      ['30 days', 'true'],
      ['Custom…', 'false'],
    ]);
    // A mousedown doesn't move focus (macOS WebKit), so the click lands.
    const week = screen.getByRole('menuitemradio', { name: '7 days' });
    expect(fireEvent.mouseDown(week)).toBe(false);
    fireEvent.click(week);

    expect(onChange).toHaveBeenCalledWith('P7D');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: 'Timespan: 7 days' })).toBeTruthy();
  });

  it('timespan_menu_closes_on_click_outside_and_escape_never_on_blur', () => {
    render(<Picker onChange={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Timespan: 30 days' }));
    fireEvent.blur(screen.getByRole('menuitemradio', { name: '30 days' }));
    expect(screen.getByRole('menu')).toBeTruthy();

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Timespan: 30 days' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('custom_timespan_over_30_days_is_refused', () => {
    const onChange = vi.fn();
    render(<Picker onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Timespan: 30 days' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Custom…' }));

    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '2026-09-01T00:00' } });
    fireEvent.change(screen.getByLabelText('End'), { target: { value: '2026-10-15T00:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this range' }));

    expect(screen.getByRole('alert').textContent).toBe('The timespan can cover at most 30 days.');
    expect(onChange).not.toHaveBeenCalled();

    // An end before the start is refused too; 30 days or less is used, as an interval.
    fireEvent.change(screen.getByLabelText('End'), { target: { value: '2026-08-15T00:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this range' }));
    expect(screen.getByRole('alert').textContent).toBe('The end must come after the start.');

    fireEvent.change(screen.getByLabelText('End'), { target: { value: '2026-09-08T12:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this range' }));
    const [interval] = onChange.mock.calls[0] as [string];
    const [start, end] = interval.split('/');
    expect(new Date(start!).getTime()).toBe(new Date('2026-09-01T00:00').getTime());
    expect(new Date(end!).getTime()).toBe(new Date('2026-09-08T12:00').getTime());
    expect(interval).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: /^Timespan: 1 Sept? – 8 Sept?$/ })).toBeTruthy();
  });
});
