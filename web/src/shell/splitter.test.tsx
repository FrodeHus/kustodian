import { fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Splitter } from './splitter';

function setup(size: number | null, parentWidth: number) {
  const onSize = vi.fn();
  const { container } = render(
    <div>
      <aside />
      <Splitter orientation="vertical" label="Resize" size={size} onSize={onSize} min={180} reserve={300} />
    </div>,
  );
  const parent = container.firstElementChild as HTMLElement;
  parent.getBoundingClientRect = () => ({ width: parentWidth, height: 600 }) as DOMRect;
  (parent.firstElementChild as HTMLElement).getBoundingClientRect = () => ({ width: 268, height: 600 }) as DOMRect;
  return { onSize, separator: within(parent).getByRole('separator', { name: 'Resize' }) };
}

describe('Splitter', () => {
  it('starts from the pane it sizes and steps by arrow keys', () => {
    const { onSize, separator } = setup(null, 1000);
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(onSize).toHaveBeenLastCalledWith(284);
  });

  it('keeps the size between the minimum and the parent less the reserve', () => {
    const { onSize, separator } = setup(690, 1000);
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(onSize).toHaveBeenLastCalledWith(700);
    const low = setup(190, 1000);
    fireEvent.keyDown(low.separator, { key: 'ArrowLeft' });
    expect(low.onSize).toHaveBeenLastCalledWith(180);
  });
});
