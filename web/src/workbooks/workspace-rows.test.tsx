import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WorkspaceRows } from './workspace-rows';

const workspace = { customerId: '11111111-1111-1111-1111-111111111111', name: 'One', resourceId: '/subscriptions/s/workspaces/One' };

describe('WorkspaceRows', () => {
  it.each([
    [{ widgets: 0, parameters: ['Tables'] }, 'choices for Tables'],
    [{ widgets: 2, parameters: ['Tables', 'Hosts'] }, '2 widgets · choices for Tables, Hosts'],
    [{ widgets: 1, parameters: [] }, '1 widget'],
    [{ widgets: 0, parameters: [], values: ['Workspace'] }, 'parameter Workspace'],
  ])('labels the use of a workspace: %j', (use, label) => {
    const { container } = render(<WorkspaceRows found={[{ workspace, ...use }]} mine={null} />);
    expect(container.textContent).toContain(label);
    expect(container.textContent).not.toContain('widget · choices');
  });
});
