import { describe, expect, it } from 'vitest';
import { findParams, mergeParameters, previewText } from './find-params';
import fixture from './find-params.fixture.json';

describe('findParams', () => {
  it('find_params_matches_host_fixture', () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
    for (const c of fixture.cases) {
      expect({ name: c.name, params: findParams(c.text) }).toEqual({ name: c.name, params: c.params });
    }
  });

  it('find_params_counts_a_placeholder_inside_a_raw_literal', () => {
    // The host doesn't (its lexer reads datetime(...) as one token) and refuses such a value as not fitting.
    expect(findParams('print datetime({start}), bool({flag})')).toEqual(['start', 'flag']);
  });
});

describe('mergeParameters', () => {
  it('merge_parameters_keeps_known_definitions_and_adds_new_ones_as_text', () => {
    const known = [
      { name: 'b', type: 'number', value: '3', required: true, choices: null },
      { name: 'gone', type: 'text', value: 'x', required: false, choices: null },
    ];
    expect(mergeParameters(['a', 'b'], known)).toEqual([
      { name: 'a', type: 'text', value: '', required: false, choices: null },
      { name: 'b', type: 'number', value: '3', required: true, choices: null },
    ]);
  });
});

describe('previewText', () => {
  const def = (name: string, type: string, value: string) => ({ name, type, value, required: false, choices: null });

  it('preview_writes_each_type_as_a_literal_and_leaves_strings_alone', () => {
    const text = 'T | where a == {s} and b > {n} and c > ago({t}) and d < {d} and e in ({l}) and f has_any ({l}) and g == "{s}"';
    expect(
      previewText(text, [def('s', 'text', 'say "hi"'), def('n', 'number', '5'), def('t', 'timespan', '7d'), def('d', 'datetime', '2026-10-21'), def('l', 'list', 'a\nb')]),
    ).toBe(
      'T | where a == "say \\"hi\\"" and b > 5 and c > ago(7d) and d < datetime(2026-10-21) and e in ("a", "b") and f has_any (dynamic(["a", "b"])) and g == "{s}"',
    );
  });

  it('preview_writes_a_list_of_numbers_unquoted_and_leaves_unknown_names', () => {
    expect(previewText('print {l}, {other}', [def('l', 'list', '1\n 2 \n')])).toBe('print dynamic([1, 2]), {other}');
  });
});
