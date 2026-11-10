import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HighlightFromCell } from './highlight-popover';

const column = { name: 'state', type: 'string' };

describe('HighlightFromCell', () => {
  it('prefills state == "FAIL", danger, row; Add with cell adds a cell rule', () => {
    const onAdd = vi.fn();
    const onClose = vi.fn();
    render(<HighlightFromCell column={column} value="FAIL" at={{ x: 10, y: 10 }} onAdd={onAdd} onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: 'Highlight rows where state == "FAIL"' });
    expect(dialog.textContent).toContain('state == "FAIL"');
    expect((screen.getByRole('combobox', { name: 'Colour' }) as HTMLSelectElement).value).toBe('danger');
    const target = screen.getByRole('combobox', { name: 'Applies to' }) as HTMLSelectElement;
    expect(target.value).toBe('row');

    fireEvent.change(target, { target: { value: 'cell' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ column: 'state', op: '==', value: 'FAIL', colour: 'danger', target: 'cell' }),
    );
  });

  it('Esc closes it', () => {
    const onClose = vi.fn();
    render(<HighlightFromCell column={column} value="FAIL" onAdd={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledWith(true);
  });
});
