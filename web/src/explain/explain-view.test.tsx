import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeError } from '../bridge';
import type { ExplainResult } from '../wire';
import { ExplainView } from './explain-view';

const bridge = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call: bridge.call,
  on: () => () => undefined,
}));

const limits = { objectsPerTable: 50000, fetchBudgetMb: 512, perObjectReadsPerTable: 2000 };

const plan: ExplainResult = {
  error: null,
  refusal: null,
  tables: [
    {
      table: 'users',
      url: "users?$select=id,displayName,signInActivity&$filter=userType eq 'Guest'&$top=999",
      select: ['id', 'displayName', 'signInActivity'],
      filter: "userType eq 'Guest'",
      top: null,
      pushed: ['userType == "Guest"'],
      local: [{ condition: 'displayName has "contractor"', reason: '`has` can’t be expressed in $filter.' }],
      perObject: ['signInActivity'],
      permissions: ['User.Read.All', 'AuditLog.Read.All'],
      docsUrl: 'https://learn.microsoft.com/graph/api/resources/user',
    },
  ],
  limits,
};

const request = { kql: 'users | where userType == "Guest"', parameters: [], origin: { line: 1, column: 1 } };

beforeEach(() => {
  bridge.call.mockReset();
});

describe('ExplainView', () => {
  it('explain_view_shows_pushed_and_local_reasons', async () => {
    bridge.call.mockResolvedValue(plan);
    const onOpenRaw = vi.fn();
    render(<ExplainView request={request} onOpenRaw={onOpenRaw} />);

    const table = await screen.findByRole('region', { name: 'users' });
    expect(bridge.call).toHaveBeenCalledWith('query.explain', { source: 'graph', kql: request.kql, parameters: [] });
    expect(within(table).getByText(`GET /beta/${plan.tables[0]!.url}`)).toBeTruthy();

    const select = within(table).getByRole('list', { name: '$select' });
    expect(within(select).getAllByRole('listitem').map((i) => i.textContent)).toEqual(['id', 'displayName', 'signInActivity']);
    expect(within(table).getByText("userType eq 'Guest'")).toBeTruthy();

    const sent = within(table).getByRole('list', { name: 'Sent to Graph' });
    expect(sent.textContent).toContain('userType == "Guest"');
    const local = within(table).getByRole('list', { name: 'Runs locally' });
    expect(local.textContent).toContain('displayName has "contractor"');
    expect(local.textContent).toContain('`has` can’t be expressed in $filter.');

    expect(within(table).getByRole('list', { name: 'Read one object at a time' }).textContent).toContain('signInActivity');
    expect(within(table).getByText('User.Read.All, AuditLog.Read.All')).toBeTruthy();
    expect(within(table).getByText(plan.tables[0]!.docsUrl)).toBeTruthy();

    expect(screen.getByText(/50,000 objects per table · 512 MB fetch budget · 2,000 per-object reads per table/)).toBeTruthy();

    fireEvent.click(within(table).getByRole('button', { name: 'Open in a raw request tab' }));
    expect(onOpenRaw).toHaveBeenCalledWith(plan.tables[0]!.url);
  });

  it('explain_shows_the_row_limit_sent_to_graph', async () => {
    bridge.call.mockResolvedValue({ ...plan, tables: [{ ...plan.tables[0]!, url: 'users?$select=id&$top=10', top: 10 }] });
    render(<ExplainView request={request} />);

    const table = await screen.findByRole('region', { name: 'users' });
    expect(within(table).getByText(/sent to Graph as \$top; the read stops after 10 objects\./)).toBeTruthy();
  });

  it('explain_without_a_row_limit_says_every_page_is_read', async () => {
    bridge.call.mockResolvedValue(plan);
    render(<ExplainView request={request} />);

    const table = await screen.findByRole('region', { name: 'users' });
    expect(within(table).getByText('None: every page is read.')).toBeTruthy();
  });

  it('explain_url_is_copyable', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    bridge.call.mockResolvedValue(plan);
    render(<ExplainView request={request} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Copy the URL' }));
    expect(writeText).toHaveBeenCalledWith(`https://graph.microsoft.com/beta/${plan.tables[0]!.url}`);
    expect(await screen.findByText('Copied the URL.')).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('explain_shows_error_position', async () => {
    bridge.call.mockResolvedValue({ ...plan, tables: [], error: { line: 2, column: 5, message: 'The name "x" does not refer to anything.' } });
    // The block began on line 4 of the editor: the position is the editor's.
    render(<ExplainView request={{ ...request, origin: { line: 4, column: 1 } }} />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Line 5, column 5: The name "x" does not refer to anything.');
  });

  it('explain_parameter_error_has_no_position', async () => {
    bridge.call.mockResolvedValue({ ...plan, tables: [], error: { line: 0, column: 0, message: 'Fill in days to explain this query.' } });
    render(<ExplainView request={request} />);

    expect((await screen.findByRole('alert')).textContent).toBe('Fill in days to explain this query.');
  });

  it('explain_shows_the_refusal', async () => {
    bridge.call.mockResolvedValue({ ...plan, tables: [], refusal: 'This query reads every table.' });
    render(<ExplainView request={request} />);

    expect((await screen.findByRole('alert')).textContent).toBe('This query reads every table.');
  });

  it('explain_that_fails_says_why', async () => {
    bridge.call.mockRejectedValue(new BridgeError('failed', 'The host stopped.'));
    render(<ExplainView request={request} />);

    expect((await screen.findByRole('alert')).textContent).toBe('The query couldn’t be explained: The host stopped.');
  });
});
