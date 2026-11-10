import { describe, expect, it } from 'vitest';
import { PALETTES, paletteVars } from './palettes';

describe('paletteVars', () => {
  it('sets a soft tint beside each status colour, --ok-soft included', () => {
    for (const p of Object.values(PALETTES)) {
      const vars = paletteVars(p);
      expect(vars['--ok-soft']).toBeTruthy();
      expect(vars['--ok-soft']).not.toBe(vars['--ok']);
    }
  });
});
