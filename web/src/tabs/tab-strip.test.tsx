import { fireEvent, render, screen, within } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommand } from '../shell/commands';
import { useTabs } from './tab-store';
import { TabStrip } from './tab-strip';

beforeEach(() => {
  useTabs.setState({ tabs: [], activeId: null, cursors: {} });
});

describe('TabStrip', () => {
  it('opening_a_tab_shows_source_badge_GR', () => {
    render(<TabStrip />);

    fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
    const items = screen.getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('Microsoft Graph query'),
      expect.stringContaining('Defender hunting query'),
      expect.stringContaining('Resource Graph query'),
      expect.stringContaining('Raw Graph request'),
    ]);
    fireEvent.click(items[0]!);

    // The badge sits beside the tab's button: it is the button of its own menu.
    const tab = screen.getByRole('tab', { selected: true }).parentElement!;
    expect(within(tab).getByTitle('Microsoft Graph')).toHaveProperty('textContent', 'GR');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(useTabs.getState().tabs).toHaveLength(1);
  });

  it('new_hunting_and_arg_tabs_from_menu_and_commands', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(<TabStrip />);

    fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Defender hunting query/ }));
    expect(within(screen.getByRole('tab', { selected: true }).parentElement!).getByTitle('Defender advanced hunting')).toHaveProperty('textContent', 'AH');
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Resource Graph query/ }));
    expect(within(screen.getByRole('tab', { selected: true }).parentElement!).getByTitle('Azure Resource Graph')).toHaveProperty('textContent', 'ARG');

    act(() => {
      expect(runCommand('tab.newHunting')).toBe(true);
    });
    act(() => {
      expect(runCommand('tab.newArg')).toBe(true);
    });
    expect(useTabs.getState().tabs.map((t) => t.source)).toEqual(['hunting', 'arg', 'hunting', 'arg']);
    // The new shortcuts collide with none of the window's.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('change_source_from_badge', () => {
    const id = useTabs.getState().open('graph');
    useTabs.getState().setText(id, 'DeviceInfo | take 10');
    render(<TabStrip />);

    const badge = screen.getByRole('button', { name: 'Source: Microsoft Graph. Change source' });
    fireEvent.mouseDown(badge);
    fireEvent.click(badge);
    const menu = screen.getByRole('menu', { name: 'Change source' });
    const current = within(menu).getByRole('menuitemradio', { name: /Microsoft Graph/ });
    expect(current.getAttribute('aria-checked')).toBe('true');
    // A mousedown in the menu doesn't move focus (macOS WebKit), so the click lands.
    const hunting = within(menu).getByRole('menuitemradio', { name: /Defender advanced hunting/ });
    expect(fireEvent.mouseDown(hunting)).toBe(false);
    fireEvent.click(hunting);

    expect(useTabs.getState().tabs[0]).toMatchObject({ source: 'hunting', text: 'DeviceInfo | take 10' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: 'Source: Defender advanced hunting. Change source' })).toBeTruthy();

    // Esc closes the menu; so does a click outside it, never a blur.
    fireEvent.click(screen.getByRole('button', { name: /Change source/ }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Change source/ }));
    fireEvent.blur(screen.getAllByRole('menuitemradio')[0]!);
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();

    // As a command too.
    act(() => {
      expect(runCommand('tab.source.arg')).toBe(true);
    });
    expect(useTabs.getState().tabs[0]?.source).toBe('arg');
    expect(runCommand('tab.source.arg')).toBe(false);
  });

  it('a_raw_tab_has_no_source_menu', () => {
    useTabs.getState().openWith({ source: 'raw', title: 'Raw request 1', text: '' });
    render(<TabStrip />);
    expect(screen.queryByRole('button', { name: /Change source/ })).toBeNull();
    expect(runCommand('tab.source.hunting')).toBe(false);
  });

  it('plus_menu_opens_a_raw_graph_request_tab', () => {
    render(<TabStrip />);

    fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Raw Graph request/ }));

    expect(useTabs.getState().tabs).toMatchObject([{ source: 'raw', title: 'Raw request 1', text: '' }]);
    const tab = screen.getByRole('tab', { selected: true });
    expect(within(tab).getByTitle('Raw Graph request')).toBeTruthy();
    expect(screen.queryByRole('menu')).toBeNull();
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

  it('confirm_close_is_a_modal_that_traps_focus_and_says_when_it_is_open', () => {
    const { open, setText } = useTabs.getState();
    const dirty = open('graph');
    setText(dirty, 'users');
    const onDialog = vi.fn();
    render(
      <>
        <TabStrip onDialog={onDialog} />
        <button type="button">Behind</button>
      </>,
    );
    expect(onDialog).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByRole('button', { name: 'Close Query 1' }));
    expect(onDialog).toHaveBeenLastCalledWith(true);
    const keep = screen.getByRole('button', { name: 'Keep it open' });
    const discard = screen.getByRole('button', { name: 'Close without saving' });
    expect(document.activeElement).toBe(keep);

    // Tab and Shift+Tab go round the two buttons.
    fireEvent.keyDown(keep, { key: 'Tab' });
    expect(document.activeElement).toBe(discard);
    fireEvent.keyDown(discard, { key: 'Tab' });
    expect(document.activeElement).toBe(keep);
    fireEvent.keyDown(keep, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(discard);

    // Focus that gets out comes back.
    act(() => screen.getByRole('button', { name: 'Behind' }).focus());
    expect(document.activeElement).toBe(keep);

    fireEvent.keyDown(keep, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onDialog).toHaveBeenLastCalledWith(false);
  });

  it('close_command_closes_a_clean_tab_and_asks_for_a_dirty_one', () => {
    const { open, setText } = useTabs.getState();
    const clean = open('graph');
    const dirty = open('graph');
    setText(dirty, 'users');
    render(<TabStrip />);

    act(() => void runCommand('tab.close'));
    expect(screen.getByRole('alertdialog').textContent).toContain('Query 2');
    fireEvent.click(screen.getByRole('button', { name: 'Close without saving' }));
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual([clean]);

    act(() => void runCommand('tab.close'));
    expect(useTabs.getState().tabs).toEqual([]);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
