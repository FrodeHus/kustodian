import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SaveButton } from './save-button';

function renderSaved() {
  const onSave = vi.fn();
  const onSaveAs = vi.fn();
  render(
    <>
      <SaveButton saved onSave={onSave} onSaveAs={onSaveAs} />
      <button type="button">Elsewhere</button>
    </>,
  );
  return { onSave, onSaveAs };
}

describe('SaveButton', () => {
  it('unsaved_tab_has_no_menu', () => {
    const onSave = vi.fn();
    render(<SaveButton saved={false} onSave={onSave} onSaveAs={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'More save options' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledOnce();
  });

  it('save_part_saves_without_opening_menu', () => {
    const { onSave, onSaveAs } = renderSaved();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledOnce();
    expect(onSaveAs).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('menu_save_as_runs_and_closes', () => {
    const { onSave, onSaveAs } = renderSaved();
    const toggle = screen.getByRole('button', { name: 'More save options' });

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const item = screen.getByRole('menuitem', { name: /Save as/ });
    expect(document.activeElement).toBe(item);
    fireEvent.click(item);

    expect(onSaveAs).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('menu_closes_on_escape_and_outside_click', () => {
    const { onSaveAs } = renderSaved();
    const toggle = screen.getByRole('button', { name: 'More save options' });

    fireEvent.click(toggle);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(toggle);
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onSaveAs).not.toHaveBeenCalled();
  });
});
