import { describe, expect, it } from 'vitest';
import { keepInside } from './keep-inside';

function mount(parent: { w: number; h: number }, child: { w: number; h: number }) {
  const p = document.createElement('div');
  const el = document.createElement('div');
  p.appendChild(el);
  Object.defineProperty(p, 'clientWidth', { value: parent.w });
  Object.defineProperty(p, 'clientHeight', { value: parent.h });
  Object.defineProperty(el, 'offsetWidth', { value: child.w });
  Object.defineProperty(el, 'offsetHeight', { value: child.h });
  return el;
}

describe('keepInside', () => {
  it('leaves a point that fits where it is', () => {
    const el = mount({ w: 500, h: 400 }, { w: 100, h: 50 });
    keepInside(el, { x: 20, y: 30 });
    expect([el.style.left, el.style.top]).toEqual(['20px', '30px']);
  });

  it('moves left and up to stay inside the parent', () => {
    const el = mount({ w: 500, h: 400 }, { w: 100, h: 50 });
    keepInside(el, { x: 480, y: 390 });
    expect([el.style.left, el.style.top]).toEqual(['400px', '350px']);
  });

  it('never goes negative', () => {
    const el = mount({ w: 80, h: 40 }, { w: 100, h: 50 });
    keepInside(el, { x: -5, y: 10 });
    expect([el.style.left, el.style.top]).toEqual(['0px', '0px']);
  });

  it('caps maxHeight at the parent height only with capHeight', () => {
    const el = mount({ w: 500, h: 400 }, { w: 100, h: 50 });
    keepInside(el, { x: 0, y: 0 });
    expect(el.style.maxHeight).toBe('');
    keepInside(el, { x: 0, y: 0 }, { capHeight: true });
    expect(el.style.maxHeight).toBe('400px');
  });

  it('does nothing without a parent', () => {
    const el = document.createElement('div');
    keepInside(el, { x: 1, y: 2 });
    expect(el.style.left).toBe('');
  });
});
