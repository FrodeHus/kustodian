import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HighlightRule } from '../wire';
import { HighlightList } from './highlight-list';

const columns = [
  { name: 'state', type: 'string' },
  { name: 'days', type: 'long' },
];
const rule = (id: string, over: Partial<HighlightRule> = {}): HighlightRule => ({
  id,
  column: 'state',
  op: '==',
  value: 'FAIL',
  colour: 'danger',
  target: 'row',
  ...over,
});

describe('HighlightList', () => {
  it('adds, edits and removes rules, calling onChange at once', () => {
    const onChange = vi.fn();
    const { rerender } = render(<HighlightList rules={[]} columns={columns} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '+ Add rule' }));
    expect(onChange).toHaveBeenLastCalledWith([
      { id: expect.any(String), column: 'state', op: '==', value: '', colour: 'danger', target: 'row' },
    ]);

    const a = rule('a');
    rerender(<HighlightList rules={[a]} columns={columns} onChange={onChange} />);
    const row = screen.getByRole('group', { name: 'Rule 1' });
    fireEvent.change(within(row).getByRole('textbox', { name: 'Value' }), { target: { value: 'OK' } });
    expect(onChange).toHaveBeenLastCalledWith([{ ...a, value: 'OK' }]);
    fireEvent.change(within(row).getByRole('combobox', { name: 'Colour' }), { target: { value: 'success' } });
    expect(onChange).toHaveBeenLastCalledWith([{ ...a, colour: 'success' }]);
    fireEvent.change(within(row).getByRole('combobox', { name: 'Applies to' }), { target: { value: 'cell' } });
    expect(onChange).toHaveBeenLastCalledWith([{ ...a, target: 'cell' }]);
    fireEvent.change(within(row).getByRole('combobox', { name: 'Operator' }), { target: { value: 'isempty' } });
    expect(onChange).toHaveBeenLastCalledWith([{ ...a, op: 'isempty', value: '' }]);
    fireEvent.click(within(row).getByRole('button', { name: 'Remove' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('hides the value for isempty, names colours, and offers the result columns', () => {
    const { container } = render(
      <HighlightList rules={[rule('a', { op: 'isnotempty', value: '' })]} columns={columns} onChange={vi.fn()} />,
    );
    expect(screen.queryByRole('textbox', { name: 'Value' })).toBeNull();
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(
      expect.arrayContaining(['Danger', 'Warning', 'Success', 'Info']),
    );
    expect([...container.querySelectorAll('datalist option')].map((o) => o.getAttribute('value'))).toEqual(['state', 'days']);
  });

  it('moves rules with the buttons and with Alt+Up/Down; Move up is disabled on the first rule', () => {
    const onChange = vi.fn();
    const [a, b] = [rule('a'), rule('b', { value: 'OK' })];
    render(<HighlightList rules={[a, b]} columns={columns} onChange={onChange} />);
    const first = screen.getByRole('group', { name: 'Rule 1' });
    expect(within(first).getByRole('button', { name: 'Move up' }).hasAttribute('disabled')).toBe(true);
    expect(
      within(screen.getByRole('group', { name: 'Rule 2' }))
        .getByRole('button', { name: 'Move down' })
        .hasAttribute('disabled'),
    ).toBe(true);

    const value = within(first).getByRole('textbox', { name: 'Value' });
    value.focus();
    fireEvent.keyDown(value, { key: 'ArrowDown', altKey: true });
    expect(onChange).toHaveBeenLastCalledWith([b, a]);
    fireEvent.click(within(screen.getByRole('group', { name: 'Rule 2' })).getByRole('button', { name: 'Move up' }));
    expect(onChange).toHaveBeenLastCalledWith([b, a]);
  });

  it('notes a rule not in this result and a value it can’t read', () => {
    render(
      <HighlightList
        rules={[rule('a', { column: 'gone' }), rule('b', { column: 'days', op: '>', value: 'abc' })]}
        columns={columns}
        onChange={vi.fn()}
      />,
    );
    expect(within(screen.getByRole('group', { name: 'Rule 1' })).getByText('Not in this result')).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Rule 2' })).getByText('Can’t read this value as long')).toBeTruthy();
  });

  it('disables + Add rule at 20', () => {
    const rules = Array.from({ length: 20 }, (_, i) => rule(`r${i}`));
    render(<HighlightList rules={rules} columns={columns} onChange={vi.fn()} />);
    const add = screen.getByRole('button', { name: '+ Add rule' });
    expect(add.hasAttribute('disabled')).toBe(true);
    expect(add.getAttribute('title')).toBe('Up to 20 rules');
  });

  it('readOnly disables every control', () => {
    render(<HighlightList rules={[rule('a'), rule('b')]} columns={columns} onChange={vi.fn()} readOnly />);
    const controls = [...screen.getAllByRole('button'), ...screen.getAllByRole('combobox'), ...screen.getAllByRole('textbox')];
    expect(controls.length).toBeGreaterThan(10);
    for (const c of controls) expect(c.hasAttribute('disabled')).toBe(true);
  });
});
