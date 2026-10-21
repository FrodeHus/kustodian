import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiagnosticEntry, RunResult } from '../wire';
import { diagnosticsText } from './copy';
import { DiagnosticsView } from './diagnostics-view';

const entries: DiagnosticEntry[] = [
  { atMs: 0, kind: 'request', detail: 'GET applications?$top=999', status: 200, durationMs: 610, bytes: 48213 },
  { atMs: 612, kind: 'throttled', detail: 'Retry-After 2 s', status: 429, durationMs: null, bytes: null },
  { atMs: 2700, kind: 'cache', detail: '37 objects', status: null, durationMs: null, bytes: null },
  { atMs: 3170, kind: 'engine', detail: '1 table · 412 rows', status: null, durationMs: 210, bytes: null },
];

const result: RunResult = {
  outcome: 'ok',
  message: null,
  error: null,
  columns: [{ name: 'displayName', type: 'string' }],
  rows: [['a'], ['b']],
  total: 2,
  tables: [],
  durationMs: 3400,
  droppedValues: 0,
  runId: 'run-1',
  diagnostics: entries,
};

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('DiagnosticsView', () => {
  it('diagnostics_copy_text_format', async () => {
    const text = [
      '+0ms request 200 GET applications?$top=999 610ms 48213B',
      '+612ms throttled 429 Retry-After 2 s',
      '+2700ms cache 37 objects',
      '+3170ms engine 1 table · 412 rows 210ms',
    ].join('\n');
    expect(diagnosticsText(entries)).toBe(text);

    render(<DiagnosticsView result={result} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy as text' }));

    expect(writeText).toHaveBeenCalledWith(text);
    expect(await screen.findByText('Copied 4 entries.')).toBeTruthy();
  });

  it('diagnostics_lists_entries_with_kind_badges', () => {
    render(<DiagnosticsView result={result} />);
    const log = screen.getByRole('list', { name: 'Event log' });

    const items = within(log).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(within(items[1]!).getByText('throttled')).toBeTruthy();
    expect(within(items[0]!).getByText('GET applications?$top=999')).toBeTruthy();
  });

  it('diagnostics_virtualizes_a_long_log', () => {
    const many = Array.from({ length: 5000 }, (_, i): DiagnosticEntry => ({ ...entries[0]!, atMs: i }));
    render(<DiagnosticsView result={{ ...result, diagnostics: many }} />);

    const shown = within(screen.getByRole('list', { name: 'Event log' })).getAllByRole('listitem').length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(100);
  });

  it('diagnostics_empty_says_so', () => {
    render(<DiagnosticsView result={{ ...result, diagnostics: [] }} />);
    expect(screen.getByText('This run logged nothing.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy as text' })).toHaveProperty('disabled', true);
  });

  it('diagnostics_wording_follows_source', () => {
    const stat = (label: string) => within(screen.getByRole('region', { name: 'Run statistics' })).queryByText(label)?.nextElementSibling?.textContent;
    const hunting: RunResult = { ...result, diagnostics: [{ atMs: 0, kind: 'request', detail: 'POST security/runHuntingQuery', status: 200, durationMs: 800, bytes: 900 }] };
    const view = render(<DiagnosticsView result={hunting} source="hunting" />);
    expect(stat('Hunting queries')).toBe('1');
    expect(stat('Graph requests')).toBeUndefined();
    expect(stat('From cache')).toBeUndefined();

    const page = { atMs: 0, kind: 'request' as const, detail: 'POST providers/Microsoft.ResourceGraph/resources', status: 200, durationMs: 800, bytes: 900 };
    view.rerender(<DiagnosticsView result={{ ...result, diagnostics: [page, page, page] }} source="arg" scope={{ kind: 'subscriptions', ids: ['a', 'b'] }} />);
    expect(stat('Pages')).toBe('3');
    expect(stat('Scope')).toBe('2 subscriptions');
    expect(stat('Graph requests')).toBeUndefined();

    view.rerender(<DiagnosticsView result={result} />);
    expect(stat('Graph requests')).toBe('0');
  });
});
