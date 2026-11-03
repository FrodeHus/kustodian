import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ExternalTool } from '../wire';
import { RunToolDialog, ToolItems } from './run-tool';
import { commandLine, fillArgs, toolColumns } from './tool-args';

const columns = [
  { name: 'displayName', type: 'string' },
  { name: 'tags', type: 'dynamic' },
];
const echo: ExternalTool = { name: 'Echo the id', command: '/bin/echo', args: ['id={displayName}', '{tags}'], mode: 'each' };

describe('run tool', () => {
  it('fills_each_placeholder_from_the_row_as_the_grid_copies_it', () => {
    expect(toolColumns(echo)).toEqual(['displayName', 'tags']);
    expect(fillArgs(echo, columns, ['a b', ['x']])).toEqual(['id=a b', '["x"]']);
    expect(fillArgs(echo, columns, [null, null])).toEqual(['id=', '']);
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

  it('says_why_a_tool_whose_columns_the_result_lacks_cant_run', async () => {
    const chosen: string[] = [];
    const errors: string[] = [];
    render(<ToolItems columns={[{ name: 'id', type: 'string' }]} onChoose={(t) => chosen.push(t.name)} onError={(e) => errors.push(e)} />);

    const item = await screen.findByRole('menuitem', { name: /Echo the name/ });
    expect(item.textContent).toBe('Echo the name · needs displayName');
    expect(item.getAttribute('aria-disabled')).toBe('true');

    fireEvent.click(item);
    expect(chosen).toEqual([]);
    expect(errors).toEqual(['Echo the name can’t run: it needs the column displayName, which this result doesn’t have.']);
  });
});
