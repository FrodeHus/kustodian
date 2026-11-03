import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ExternalTool } from '../wire';
import { RunToolDialog, ToolItems } from './run-tool';
import { commandLine, defaultMapping, fillArgs, toolColumns } from './tool-args';

const columns = [
  { name: 'displayName', type: 'string' },
  { name: 'tags', type: 'dynamic' },
];
const echo: ExternalTool = { name: 'Echo the id', command: '/bin/echo', args: ['id={displayName}', '{tags}'], mode: 'each' };

describe('run tool', () => {
  it('fills_each_placeholder_from_the_row_as_the_grid_copies_it', () => {
    expect(toolColumns(echo)).toEqual(['displayName', 'tags']);
    const mapping = defaultMapping(echo, columns);
    expect(fillArgs(echo, columns, ['a b', ['x']], mapping)).toEqual(['id=a b', '["x"]']);
    expect(fillArgs(echo, columns, [null, null], mapping)).toEqual(['id=', '']);
  });

  it('maps_a_parameter_to_its_column_by_name_then_ignoring_case', () => {
    const tool: ExternalTool = { name: 't', command: '/bin/echo', args: ['{DISPLAYNAME}', '{upn}'], mode: 'each' };
    expect(defaultMapping(tool, columns)).toEqual({ DISPLAYNAME: 'displayName', upn: '' });
    expect(fillArgs(tool, columns, ['Ann', null], { DISPLAYNAME: 'displayName', upn: 'displayName' })).toEqual(['Ann', 'Ann']);
  });

  it('quotes_arguments_that_arent_plain_for_reading', () => {
    expect(commandLine('/bin/echo', ['id=a', "it's $(x)", ''])).toBe(`/bin/echo id=a 'it'\\''s $(x)' ''`);
  });

  it('shows_the_first_command_then_runs_and_shows_each_output', async () => {
    render(<RunToolDialog tool={echo} columns={columns} rows={[['u1', null], ['u2', null]]} onClose={() => undefined} />);

    expect(screen.getByText('Runs once for each of 2 rows. The first:')).toBeTruthy();
    expect(screen.getByText(`/bin/echo id=u1 ''`)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    const output = await screen.findByLabelText('Output');
    expect(output.textContent).toContain('$ /bin/echo name=u1\nname=u1\n');
    expect(output.textContent).toContain('$ /bin/echo name=u2\nname=u2\n');
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('batch_mode_says_the_rows_go_on_stdin', () => {
    const batch: ExternalTool = { name: 'Cat', command: '/bin/cat', args: [], mode: 'batch' };
    render(<RunToolDialog tool={batch} columns={columns} rows={[['u1', null]]} onClose={() => undefined} />);

    expect(screen.getByText('Runs once, with 1 row on stdin as JSON:')).toBeTruthy();
  });

  it('says_which_parameters_need_a_column_and_still_opens_the_tool', async () => {
    const chosen: string[] = [];
    render(<ToolItems columns={[{ name: 'id', type: 'string' }]} onChoose={(t) => chosen.push(t.name)} onError={() => undefined} />);

    const item = await screen.findByRole('menuitem', { name: /Echo the name/ });
    expect(item.textContent).toBe('Echo the name · map displayName');
    fireEvent.click(item);
    expect(chosen).toEqual(['Echo the name']);
  });

  it('runs_only_once_each_parameter_has_a_column_and_sends_the_mapping', async () => {
    const tool: ExternalTool = { name: 'Echo', command: '/bin/echo', args: ['name={displayName}'], mode: 'each' };
    const cols = [
      { name: 'id', type: 'string' },
      { name: 'appName', type: 'string' },
    ];
    render(<RunToolDialog tool={tool} columns={cols} rows={[['1', 'Portal']]} onClose={() => undefined} />);

    const run = screen.getByRole('button', { name: 'Run' });
    expect((run as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByRole('combobox', { name: '{displayName}' }), { target: { value: 'appName' } });
    expect(screen.getByText('/bin/echo name=Portal')).toBeTruthy();
    fireEvent.click(run);

    const output = await screen.findByLabelText('Output');
    expect(output.textContent).toContain('name=Portal');
  });
});
