import { describe, expect, it } from 'vitest';
import { heatmapAxes, heatmapShape } from './heatmap-shape';

const col = (name: string, type: string) => ({ name, type });

describe('heatmapShape', () => {
  it('heatmap_shape_defaults', () => {
    expect(heatmapShape([col('Day', 'timespan'), col('Hour', 'int'), col('count_', 'long')], [])).toEqual({
      type: 'heatmap',
      x: 'Hour',
      split: 'Day',
      series: ['count_'],
    });
    expect(heatmapShape([col('Computer', 'string'), col('TimeGenerated', 'datetime'), col('count_', 'long')], [])).toMatchObject({
      x: 'TimeGenerated',
      split: 'Computer',
    });
    expect(heatmapShape([col('type', 'string'), col('location', 'string'), col('n', 'long')], [])).toMatchObject({
      x: 'location',
      split: 'type',
      series: ['n'],
    });
    expect(heatmapAxes([col('a', 'string'), col('d', 'dynamic'), col('n', 'long')], 'n')).toEqual(['a']);
  });

  it('heatmap_shape_render_options', () => {
    const cols = [col('a', 'string'), col('b', 'string'), col('n', 'long')];
    expect(heatmapShape(cols, [], { xcolumn: 'a', series: ['b'] })).toMatchObject({ x: 'a', split: 'b' });
    expect(heatmapShape(cols, [], { xcolumn: 'a', series: ['a'] })).toMatchObject({ x: 'a', split: 'b' });
  });

  it('heatmap_shape_needs_two_axes_and_a_number', () => {
    expect(heatmapShape([col('a', 'string'), col('n', 'long')], [])).toBeNull();
    expect(heatmapShape([col('a', 'string'), col('b', 'string')], [])).toBeNull();
  });
});
