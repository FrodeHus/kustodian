import { describe, expect, it } from 'vitest';
import { newToolButton } from './model';
import { buttonName, effectiveSelection, NO_SELECTION, toolTarget } from './tool-buttons';

const rows = Array.from({ length: 14 }, (_, i) => [i]);
const every = rows.map((_, i) => i);

describe('toolTarget', () => {
  it('runs on the selected rows, in shown order', () => {
    expect(toolTarget('selectedOrAll', rows, { selected: [3, 1], shown: every })).toEqual({
      rows: [[1], [3]],
      count: '2',
      heading: 'on 2 selected rows',
    });
  });

  it('says "row" for one selected row', () => {
    expect(toolTarget('selected', rows, { selected: [5], shown: every }).heading).toBe('on 1 selected row');
  });

  it('runs on every row when none are selected and the button allows it', () => {
    const t = toolTarget('selectedOrAll', rows, { selected: [], shown: every });
    expect(t.rows).toHaveLength(14);
    expect([t.count, t.heading]).toEqual(['all 14', 'on all 14 rows']);
  });

  it('is off when none are selected and the button needs a selection', () => {
    const t = toolTarget('selected', rows, { selected: [], shown: every });
    expect(t.rows).toEqual([]);
    expect(t.count).toBe('0');
  });

  it('ignores a selected row that is not shown', () => {
    const t = toolTarget('selectedOrAll', rows, { selected: [20], shown: [0, 1] });
    expect(t.rows).toEqual([[0], [1]]);
    expect(t.count).toBe('all 2');
  });

  it('treats shown null as every row and shown [] as none', () => {
    expect(toolTarget('selectedOrAll', rows, { selected: [], shown: null }).rows).toHaveLength(14);
    expect(toolTarget('selectedOrAll', rows, { selected: [], shown: [] }).rows).toEqual([]);
  });
});

describe('buttonName and effectiveSelection', () => {
  it('names a button by its trimmed label, else its tool', () => {
    expect(buttonName({ ...newToolButton(), label: ' Stop ', tool: 'T' })).toBe('Stop');
    expect(buttonName({ ...newToolButton(), label: '  ', tool: 'T' })).toBe('T');
  });

  it('is empty while selection is off, whatever the store holds', () => {
    const stored = { selected: [1], shown: [0, 1] };
    expect(effectiveSelection('none', stored)).toBe(NO_SELECTION);
    expect(effectiveSelection('multi', stored)).toBe(stored);
    expect(effectiveSelection('multi', undefined)).toBe(NO_SELECTION);
  });
});
