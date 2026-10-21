import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTabs } from './tab-store';
import { TabStrip } from './tab-strip';

beforeEach(() => {
  useTabs.setState({ tabs: [], activeId: null, cursors: {} });
});

describe('TabStrip', () => {
  it('opening_a_tab_shows_source_badge_GR', () => {
    render(<TabStrip />);

    fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
    // Plan 1 offers Graph queries only.
    const items = screen.getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([expect.stringContaining('Microsoft Graph query')]);
    fireEvent.click(items[0]!);

    const tab = screen.getByRole('tab', { selected: true });
    expect(within(tab).getByTitle('Microsoft Graph')).toHaveProperty('textContent', 'GR');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(useTabs.getState().tabs).toHaveLength(1);
  });

  it('closing_dirty_tab_asks_to_confirm', () => {
    const { open, setText } = useTabs.getState();
    const clean = open('graph');
    const dirty = open('graph');
    setText(dirty, 'users | count');
    render(<TabStrip />);

    // A tab without changes closes at once.
    fireEvent.click(screen.getByRole('button', { name: 'Close Query 1' }));
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual([dirty]);
    expect(screen.queryByRole('alertdialog')).toBeNull();

    // A tab with unsaved changes asks first; Keep leaves it open.
    fireEvent.click(screen.getByRole('button', { name: 'Close Query 2' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('Query 2');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it open' }));
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual([dirty]);

    fireEvent.click(screen.getByRole('button', { name: 'Close Query 2' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Close without saving' }));
    expect(useTabs.getState().tabs).toEqual([]);
    expect(clean).not.toBe(dirty);
  });
});
