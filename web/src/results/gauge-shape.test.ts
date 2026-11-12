import { describe, expect, it } from 'vitest';
import type { ChartSpec } from './chart-shape';
import { gaugeData, gaugeLabels, gaugeRange, gaugeShape, gaugeText } from './gauge-shape';
import { dateTick } from './chart-style';

const col = (name: string, type: string) => ({ name, type });
const COLS = [col('tenant', 'string'), col('Score', 'real')];
const SPEC: ChartSpec = { type: 'gauge', x: 'tenant', series: ['Score'], split: null };
const one = (value: unknown, picked = {}) => gaugeData(COLS, [['Contoso', value]], SPEC, picked);

describe('gaugeShape', () => {
  it('picks the last number column as the value and the first string column as the label', () => {
    const columns = [col('tenant', 'string'), col('currentScore', 'real'), col('maxScore', 'real'), col('Score', 'real')];
    expect(gaugeShape(columns)).toEqual({ type: 'gauge', x: 'tenant', series: ['Score'], split: null });
    expect(gaugeLabels(columns, 'Score')).toEqual(['tenant', 'currentScore', 'maxScore']);
  });

  it('falls back to a datetime label, then to none; null without a number column', () => {
    expect(gaugeShape([col('createdDateTime', 'datetime'), col('Score', 'real')])).toMatchObject({ x: 'createdDateTime' });
    expect(gaugeShape([col('Score', 'long')])).toMatchObject({ x: null });
    expect(gaugeShape([col('tenant', 'string')])).toBeNull();
  });

  it('follows xcolumn and ycolumns when they name valid columns', () => {
    const columns = [col('a', 'string'), col('tenant', 'string'), col('currentScore', 'real'), col('Score', 'real')];
    expect(gaugeShape(columns, { xcolumn: 'tenant', ycolumns: ['currentScore'] })).toMatchObject({ x: 'tenant', series: ['currentScore'] });
    expect(gaugeShape(columns, { xcolumn: 'nope', ycolumns: ['a'] })).toMatchObject({ x: 'a', series: ['Score'] });
  });
});

describe('gaugeRange and gaugeText', () => {
  it('defaults to 0-100 and flags an empty range', () => {
    expect(gaugeRange({})).toEqual({ min: 0, max: 100, valid: true });
    expect(gaugeRange({ min: 50 })).toEqual({ min: 50, max: 100, valid: true });
    expect(gaugeRange({ min: 100, max: 100 })).toEqual({ min: 0, max: 100, valid: false });
  });

  it('rounds to at most one decimal', () => {
    expect(gaugeText(72.4561)).toBe('72.5');
    expect(gaugeText(80)).toBe('80');
    expect(gaugeText(0.04)).toBe('0');
  });
});

describe('gaugeData', () => {
  it('marks good by direction, at target counting as good', () => {
    const good = (v: number, picked: object) => one(v, picked).gauges[0]?.good;
    expect([72, 80, 85].map((v) => good(v, { target: 80 }))).toEqual([false, true, true]);
    expect([38, 30, 22].map((v) => good(v, { target: 30, better: 'lower' }))).toEqual([false, true, true]);
  });

  it('describes a gauge for assistive tech', () => {
    const none = one(72);
    expect(none.gauges[0]).toMatchObject({ good: null, aria: 'Contoso: 72' });
    expect(none.targetFill).toBeUndefined();
    expect(one(72, { target: 80 }).gauges[0]?.aria).toBe('Contoso: 72, desired 80, higher is better, below target');
    expect(one(80, { target: 80 }).gauges[0]?.aria).toBe('Contoso: 80, desired 80, higher is better, at target');
    expect(one(90, { target: 80, better: 'lower' }).gauges[0]?.aria).toBe('Contoso: 90, desired 80, lower is better, above target');
  });

  it('reads null, empty and non-numeric values as no value', () => {
    for (const v of [null, '', 'abc']) {
      expect(one(v, { target: 80 }).gauges[0]).toMatchObject({ value: null, text: '–', fill: 0, good: null, aria: 'Contoso: no value' });
    }
  });

  it('clamps fills to the ring and scales from the range', () => {
    const high = one(130, { target: 120 });
    expect(high.gauges[0]).toMatchObject({ fill: 1, text: '130' });
    expect(high.targetFill).toBe(1);
    expect(one(-5).gauges[0]?.fill).toBe(0);
    expect(one(75, { min: 50, max: 100 }).gauges[0]?.fill).toBe(0.5);
  });

  it('shows the first 24 rows with a note naming how to show fewer', () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => [`t${i}`, i]);
    const d = gaugeData(COLS, rows(90), SPEC, {});
    expect(d.gauges).toHaveLength(24);
    expect(d.gauges[0]?.label).toBe('t0');
    expect(d.total).toBe(90);
    expect(d.note).toBe('Showing 24 of 90 rows. Add `take`, `top` or a filter to show fewer.');
    expect(gaugeData(COLS, rows(24), SPEC, {}).note).toBeUndefined();
    expect(gaugeData(COLS, rows(1200), SPEC, {}).note).toContain('1,200');
    const dated = [col('createdDateTime', 'datetime'), col('Score', 'real')];
    const spec: ChartSpec = { type: 'gauge', x: 'createdDateTime', series: ['Score'], split: null };
    const dt = gaugeData(
      dated,
      Array.from({ length: 90 }, () => ['2026-01-02T00:00:00Z', 1]),
      spec,
      {},
    );
    expect(dt.note).toBe('Showing 24 of 90 rows. Add `top 1 by createdDateTime` (or a filter) to show fewer.');
    expect(dt.gauges[0]).toMatchObject({ key: '2026-01-02T00:00:00Z', label: dateTick('2026-01-02T00:00:00Z') });
  });

  it('numbers the rows when there is no label column, and blanks a null label', () => {
    const d = gaugeData([col('Score', 'real')], [[1], [2]], { type: 'gauge', x: null, series: ['Score'], split: null }, {});
    expect(d.gauges.map((g) => g.label)).toEqual(['Row 1', 'Row 2']);
    expect(d.labelColumn).toBeNull();
    expect(gaugeData(COLS, [[null, 5]], SPEC, {}).gauges[0]).toMatchObject({ label: '', key: '' });
  });
});
