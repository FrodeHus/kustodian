import { describe, expect, it } from 'vitest';
// Microsoft's KQL parser (Kusto.Language, as the editor's language service runs it), to check the output parses as meant. It is
// Bridge.NET output and needs Node's `global` first.
import '../editor/worker-global';
import '@kusto/language-service-next/bridge.min.js';
import '@kusto/language-service-next/Kusto.Language.Bridge.min.js';
import { kqlString, toDatatable } from './to-datatable';

interface KustoList<T> {
  Count: number;
  getItem(i: number): T;
}

interface KustoCode {
  GetDiagnostics(): KustoList<{ Message: string }>;
  ResultType: { Columns: KustoList<{ Name: string; Type: { Name: string } }> } | null;
}

const kusto = (globalThis as unknown as { Kusto: { Language: { KustoCode: { ParseAndAnalyze(text: string): KustoCode } } } }).Kusto;

const items = <T,>(list: KustoList<T>): T[] => Array.from({ length: list.Count }, (_, i) => list.getItem(i));

/** What Kusto.Language makes of a query: its errors, and its result's columns as `name:type`. */
function analyze(kql: string) {
  const code = kusto.Language.KustoCode.ParseAndAnalyze(kql);
  return {
    errors: items(code.GetDiagnostics()).map((d) => d.Message),
    columns: code.ResultType ? items(code.ResultType.Columns).map((c) => `${c.Name}:${c.Type.Name}`) : [],
  };
}

describe('toDatatable', () => {
  it('to_datatable_infers_types_and_escapes', () => {
    const { kql, truncated } = toDatatable('users_rows', [
      { id: 'a"1\\', n: 1, r: 1.5, ok: true, at: '2025-03-04T10:15:00Z', tags: ['x', 'y"'], where: 'yesterday' },
      { id: 'line\nbreak', n: 2, r: 2, ok: false, at: '2025-03-05', extra: { k: 'v' } },
      { n: null, "a'];print 1;//": 'evil")\n| take 0' },
    ]);

    expect(truncated).toBe(false);
    expect(kql).toBe(
      [
        "let users_rows = datatable(id:string, n:long, r:real, ok:bool, at:datetime, tags:dynamic, ['where']:string, extra:dynamic, ['a\\'];print 1;//']:string) [",
        '    "a\\"1\\\\", long(1), real(1.5), true, datetime(2025-03-04T10:15:00Z), dynamic(["x", "y\\""]), "yesterday", dynamic(null), "",',
        '    "line\\nbreak", long(2), real(2), false, datetime(2025-03-05), dynamic(null), "", dynamic({"k": "v"}), "",',
        '    "", long(null), real(null), bool(null), datetime(null), dynamic(null), "", dynamic(null), "evil\\")\\n| take 0"',
        '];',
        'users_rows',
      ].join('\n'),
    );
  });

  it('to_datatable_output_parses_as_one_datatable_whatever_the_keys_and_values', () => {
    const hostile = "a'];print 1;//";
    const { kql } = toDatatable("x'];print 2", [
      { [hostile]: 'evil")\n| take 0 //', 'b\\': "'];print 3", "c\n']": '\u0000 ', where: 1.5, at: '2025-03-04T10:15:00.1234567Z' },
      { obj: { 'k\'"': ['")', null, true, 2] }, at: null },
    ]);

    expect(analyze(kql)).toEqual({
      errors: [],
      columns: [`${hostile}:string`, 'b\\:string', "c\n']:string", 'where:real', 'at:datetime', 'obj:dynamic'],
    });
  });

  it('to_datatable_escapes_control_characters_like_the_host', () => {
    expect(kqlString('a\rb\tc\u0001d\u007f', '"')).toBe('"a\\rb\\tc\\u0001d\\u007f"');
    expect(kqlString("it's \\ here", "'")).toBe("'it\\'s \\\\ here'");
  });

  it('to_datatable_mixed_values_become_dynamic_and_scalars_get_a_value_column', () => {
    const { kql } = toDatatable('mixed', [{ v: 1 }, { v: 'one' }]);
    expect(kql).toBe('let mixed = datatable(v:dynamic) [\n    dynamic(1),\n    dynamic("one")\n];\nmixed');

    const scalars = toDatatable('names', ['a', 'b']).kql;
    expect(scalars).toBe('let names = datatable(value:string) [\n    "a",\n    "b"\n];\nnames');
  });

  it('to_datatable_names_that_are_not_identifiers_are_made_safe', () => {
    expect(toDatatable("x'];print 1", [{ a: 1 }]).kql.split('\n')[0]).toBe('let x___print_1 = datatable(a:long) [');
    expect(toDatatable('where', [{ a: 1 }]).kql.split('\n')[0]).toBe('let data_where = datatable(a:long) [');
  });

  it('to_datatable_of_an_empty_array_has_one_dynamic_column', () => {
    expect(toDatatable('empty', []).kql).toBe('let empty = datatable(value:dynamic) [\n];\nempty');
  });

  it('to_datatable_truncates_at_5000', () => {
    const rows = Array.from({ length: 5001 }, (_, i) => ({ i }));
    const { kql, truncated } = toDatatable('many', rows);

    expect(truncated).toBe(true);
    expect(kql.split('\n').filter((l) => l.startsWith('    long('))).toHaveLength(5000);
    expect(kql).toContain('long(4999)');
    expect(kql).not.toContain('long(5000)');

    expect(toDatatable('few', rows, 10).truncated).toBe(true);
    expect(toDatatable('all', rows.slice(0, 5000)).truncated).toBe(false);
  });
});
