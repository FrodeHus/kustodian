import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalTool, ToolList } from '../wire';
import { ExternalTools } from './external-tools';

const bridge = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../bridge', async (importOriginal) => ({ ...(await importOriginal<typeof import('../bridge')>()), call: bridge.call }));

const revoke: ExternalTool = { name: 'Revoke sessions', command: '/opt/homebrew/bin/az', args: ['rest', '--url', 'users/{id}'], mode: 'each' };
const jq: ExternalTool = { name: 'JSON lines', command: 'jq', args: ['-c', '.[]'], mode: 'batch' };

let list: ToolList;
const saved = () => bridge.call.mock.calls.filter(([m]) => m === 'tools.save').map(([, p]) => (p as { tools: ExternalTool[] }).tools);

beforeEach(() => {
  list = { tools: [revoke, jq], problem: null, path: '/data/tools.json', missing: ['JSON lines'] };
  bridge.call.mockReset();
  bridge.call.mockImplementation((method: string, params?: { tools: ExternalTool[] }) => {
    if (method === 'tools.save') {
      list = { ...list, tools: params?.tools ?? [], missing: [] };
    }
    if (method === 'tools.pickCommand') {
      return Promise.resolve({ path: '/usr/bin/env' });
    }
    return Promise.resolve(method === 'tools.list' || method === 'tools.save' ? list : null);
  });
});

const row = (name: string) => screen.getByText(name, { selector: 'b' }).closest('li') as HTMLElement;

describe('ExternalTools', () => {
  it('lists the tools in order, with a warning for a command that is no file', async () => {
    render(<ExternalTools />);

    const items = await screen.findAllByRole('listitem');
    expect(items.map((li) => within(li).getByText(/./, { selector: 'b' }).textContent)).toEqual(['Revoke sessions', 'JSON lines']);
    expect(within(row('JSON lines')).getByText('No file at “jq”: give the full path')).toBeTruthy();
    expect(within(row('Revoke sessions')).queryByText(/No file/)).toBeNull();
  });

  it('adds a tool from the dialog, one argument per box', async () => {
    render(<ExternalTools />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add tool' }));
    const dialog = screen.getByRole('dialog', { name: 'Add tool' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Echo' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Browse…' }));
    await waitFor(() => expect(within(dialog).getByLabelText<HTMLInputElement>('Command').value).toBe('/usr/bin/env'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add argument' }));
    fireEvent.change(within(dialog).getByLabelText('Argument 1'), { target: { value: 'id is {id}' } });
    expect(within(dialog).getByText("/usr/bin/env 'id is {id}'")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save tool' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(saved()).toEqual([[revoke, jq, { name: 'Echo', command: '/usr/bin/env', args: ['id is {id}'], mode: 'each' }]]);
    expect(row('Echo')).toBeTruthy();
  });

  it('won’t save a batch tool whose arguments name a column, or a name already taken', async () => {
    render(<ExternalTools />);
    await screen.findByText('Revoke sessions', { selector: 'b' });
    fireEvent.click(within(row('Revoke sessions')).getByRole('button', { name: 'Edit…' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit tool' });
    fireEvent.click(within(dialog).getByLabelText('Once, rows as JSON on stdin'));

    expect(within(dialog).getByRole('alert').textContent).toContain('batch mode');
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Save tool' }).disabled).toBe(true);

    fireEvent.click(within(dialog).getByLabelText('Once per row'));
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'JSON lines' } });
    expect(within(dialog).getByRole('alert').textContent).toBe('There is already a tool named JSON lines.');
  });

  it('keeps the dialog open with the host’s message when the save is refused', async () => {
    render(<ExternalTools />);
    await screen.findByText('Revoke sessions', { selector: 'b' });
    fireEvent.click(within(row('Revoke sessions')).getByRole('button', { name: 'Edit…' }));
    bridge.call.mockImplementationOnce(() => Promise.reject(new Error('tools.json changed.')));
    fireEvent.click(screen.getByRole('button', { name: 'Save tool' }));

    expect((await within(screen.getByRole('dialog')).findByRole('alert')).textContent).toContain('tools.json changed.');
  });

  it('moves, duplicates and deletes, saving each change at once', async () => {
    render(<ExternalTools />);
    fireEvent.click(await screen.findByRole('button', { name: 'Move Revoke sessions down' }));
    await waitFor(() => expect(saved()).toEqual([[jq, revoke]]));

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate JSON lines' }));
    await waitFor(() => expect(saved()[1]?.map((t) => t.name)).toEqual(['JSON lines', 'JSON lines copy', 'Revoke sessions']));

    fireEvent.click(screen.getByRole('button', { name: 'Delete Revoke sessions' }));
    expect(saved()).toHaveLength(2);
    fireEvent.click(within(screen.getByRole('group', { name: 'Delete “Revoke sessions”?' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(saved()[2]?.map((t) => t.name)).toEqual(['JSON lines', 'JSON lines copy']));
  });

  it('shows what is wrong with tools.json and changes nothing until it is fixed', async () => {
    list = { tools: [], problem: 'tools.json isn’t valid: line 9.', path: '/data/tools.json', missing: [] };
    render(<ExternalTools />);

    expect(await screen.findByText('tools.json isn’t valid: line 9.')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add tool' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Read it again' }));
    expect(bridge.call.mock.calls.filter(([m]) => m === 'tools.list')).toHaveLength(2);
  });

  it('closes only the dialog on Escape', async () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <ExternalTools />
      </div>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Add tool' }));
    fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(outer).not.toHaveBeenCalled();
  });
});
