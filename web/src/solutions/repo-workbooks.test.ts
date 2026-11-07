import { describe, expect, it } from 'vitest';
import { parseWorkbook } from '../workbooks/model';

const files = import.meta.glob('../../../Solutions/*/workbooks/*.json', { eager: true, import: 'default' });

const withoutModifiedAt = (v: unknown) => {
  const { modifiedAt: _modifiedAt, ...rest } = v as Record<string, unknown>;
  return rest;
};

describe('the repo Solutions workbooks', () => {
  it('has workbooks to check', () => {
    expect(Object.keys(files).length).toBeGreaterThan(0);
  });

  it.each(Object.entries(files))('%s is in the form parseWorkbook produces', (file, json) => {
    const parsed = parseWorkbook(json);
    expect(typeof parsed, `${file}: ${String(parsed)}`).not.toBe('string');
    expect(withoutModifiedAt(parsed), file).toEqual(withoutModifiedAt(json));
  });
});
