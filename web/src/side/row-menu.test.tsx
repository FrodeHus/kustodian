import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RowMenu } from './row-menu';

function setup() {
  const rename = vi.fn();
  const remove = vi.fn();
  render(
    <>
      <RowMenu
        name="Apps"
        actions={[
          { label: 'Rename', run: rename },
          { label: 'Delete', run: remove },
        ]}
      />
      <button type="button">Elsewhere</button>
    </>,
  );
  return { rename, remove, more: screen.getByRole('button', { name: 'More for Apps' }) };
}

describe('RowMenu', () => {
  it('row_menu_works_from_the_keyboard', () => {
    const { rename, remove, more } = setup();

    fireEvent.click(more);
    const [renameItem, deleteItem] = screen.getAllByRole('menuitem');
    // Focus moves into the menu, and the arrows move it round.
    expect(document.activeElement).toBe(renameItem);
    fireEvent.keyDown(renameItem!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(deleteItem);
    fireEvent.keyDown(deleteItem!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(renameItem);
    fireEvent.keyDown(renameItem!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(deleteItem);

    // Esc closes it and puts focus back on "⋯".
    fireEvent.keyDown(deleteItem!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(more);
    expect(remove).not.toHaveBeenCalled();

    // Choosing an item runs it, closes the menu and returns focus too.
    fireEvent.click(more);
    fireEvent.keyDown(screen.getAllByRole('menuitem')[0]!, { key: 'End' });
    fireEvent.click(document.activeElement!);
    expect(remove).toHaveBeenCalledOnce();
    expect(rename).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it('row_menu_closes_when_focus_tabs_away', () => {
    const { more } = setup();
    fireEvent.click(more);
    const item = screen.getAllByRole('menuitem')[0]!;

    fireEvent.blur(item, { relatedTarget: screen.getByRole('button', { name: 'Elsewhere' }) });

    expect(screen.queryByRole('menu')).toBeNull();
  });
});
