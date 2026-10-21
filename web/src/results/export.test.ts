import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportResult, toCsv, toJson, toMarkdown } from './export';

const call = vi.hoisted(() => vi.fn());
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call,
}));

const columns = [
  { name: 'name', type: 'string' },
  { name: 'n', type: 'long' },
  { name: 'tags', type: 'dynamic' },
];

beforeEach(() => {
  call.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Makes the default locale format numbers with `format`. */
function numberFormat(format: (n: number) => string) {
  vi.spyOn(Intl, 'NumberFormat').mockImplementation(function NumberFormat() {
    return { format } as unknown as Intl.NumberFormat;
  });
}

describe('export', () => {
  it('Csv_escapes_quotes_commas_and_newlines', () => {
    const rows = [
      ['Contoso, Ltd', 1, { kind: 'secret' }],
      ['Say "hi"', null, null],
      ['two\nlines', 3, ['a', 'b']],
      ['carriage\rreturn', 4, true],
    ];

    expect(toCsv(columns, rows)).toBe(
      [
        'name,n,tags',
        '"Contoso, Ltd",1,"{""kind"":""secret""}"',
        '"Say ""hi""",,',
        '"two\nlines",3,"[""a"",""b""]"',
        '"carriage\rreturn",4,true',
      ].join('\r\n'),
    );
  });

  it('Excel_csv_uses_semicolon_and_bom_for_decimal_comma_locale', async () => {
    // A locale that writes 1.5 as "1,5", as Norwegian does.
    numberFormat((n) => String(n).replace('.', ','));
    call.mockResolvedValue({ path: '/tmp/q.csv', name: 'q.csv' });

    await exportResult('excel', 'Query 1', { columns: columns.slice(0, 2), rows: [['a;b', 1.5]] });

    expect(call).toHaveBeenCalledWith('file.saveAs', {
      suggestedName: 'Query 1.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
      content: '﻿name;n\r\n"a;b";1.5',
    });
  });

  it('Excel_csv_keeps_comma_for_decimal_point_locale', async () => {
    numberFormat((n) => String(n));
    call.mockResolvedValue(null);

    await exportResult('excel', 'Query 1', { columns: columns.slice(0, 1), rows: [['a']] });

    expect(call.mock.calls[0]?.[1]).toMatchObject({ content: '﻿name\r\na' });
  });

  it('Markdown_escapes_pipes', () => {
    const rows = [['a|b', 1, { x: 'c|d' }], ['line\nbreak', null, null]];

    expect(toMarkdown(columns, rows)).toBe(
      ['| name | n | tags |', '| --- | --- | --- |', '| a\\|b | 1 | {"x":"c\\|d"} |', '| line<br>break |  |  |'].join('\n'),
    );
  });

  it('Json_export_keys_by_column', () => {
    const rows = [['Contoso', 1, { kind: 'secret' }], ['Legacy', null, ['a']]];

    expect(JSON.parse(toJson(columns, rows))).toEqual([
      { name: 'Contoso', n: 1, tags: { kind: 'secret' } },
      { name: 'Legacy', n: null, tags: ['a'] },
    ]);
  });

  it('Export_writes_all_50000_rows', async () => {
    const rows = Array.from({ length: 50000 }, (_, i) => [`app ${i}`, i, null]);
    let written = '';
    call.mockImplementation((_method: string, params: { content: string }) => {
      written = params.content;
      return Promise.resolve({ path: '/tmp/Query 1.csv', name: 'Query 1.csv' });
    });

    const file = await exportResult('csv', 'Query 1', { columns, rows });

    expect(file).toEqual({ path: '/tmp/Query 1.csv', name: 'Query 1.csv' });
    const lines = written.split('\r\n');
    expect(lines).toHaveLength(50001);
    expect(lines.at(-1)).toBe('app 49999,49999,');
  });

  it('export_names_and_filters_per_format', async () => {
    call.mockResolvedValue(null);
    const table = { columns, rows: [] };

    await exportResult('json', 'apps.kql', table);
    await exportResult('markdown', 'Query 2', table);

    expect(call.mock.calls[0]?.[1]).toMatchObject({ suggestedName: 'apps.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    expect(call.mock.calls[1]?.[1]).toMatchObject({ suggestedName: 'Query 2.md', filters: [{ name: 'Markdown', extensions: ['md'] }] });
  });
});
