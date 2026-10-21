import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PlannedGroup, PlannedPermission } from '../wire';
import { PermissionList } from './permission-list';
import { lostTables, permKey } from './permission-plan';

function perm(name: string, tables: string[], extra: Partial<PlannedPermission> = {}): PlannedPermission {
  return { resource: 'Microsoft Graph', resourceAppId: 'g', name, adminConsent: true, description: '', tables, unlocks: null, ticked: true, ...extra };
}

const all = perm('Directory.Read.All', ['users', 'groups', 'devices']);
const users = perm('User.Read.All', ['users']);
const groupsOnly = perm('Group.Read.All', ['groups']);
const groups: PlannedGroup[] = [
  { id: 'graph', title: 'Graph', subgroups: [{ title: 'Directory', permissions: [all, users, groupsOnly] }] },
];

describe('lostTables', () => {
  it('only_counts_tables_with_no_other_ticked_cover', () => {
    const ticked = new Set([permKey(all), permKey(users), permKey(groupsOnly)]);
    expect(lostTables(users, groups, ticked)).toEqual([]);
    ticked.delete(permKey(all));
    expect(lostTables(all, groups, ticked)).toEqual(['devices']);
  });
});

describe('PermissionList', () => {
  it('group_checkbox_is_mixed_when_partly_ticked', () => {
    const ticked = new Set([permKey(all)]);
    render(<PermissionList groups={groups} ticked={ticked} onToggle={vi.fn()} />);
    const box = screen.getByRole<HTMLInputElement>('checkbox', { name: 'Graph' });
    expect(box.indeterminate).toBe(true);
    expect(box.checked).toBe(false);
  });

  it('group_checkbox_toggles_all_its_permissions', () => {
    const onToggle = vi.fn();
    render(<PermissionList groups={groups} ticked={new Set()} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Directory' }));
    expect(onToggle).toHaveBeenCalledWith([permKey(all), permKey(users), permKey(groupsOnly)], true);
  });

  it('shows_you_lose_for_an_unticked_permission_and_unlocks_for_a_source', () => {
    const source = perm('user_impersonation', [], { unlocks: 'Resource Graph', adminConsent: false });
    const list: PlannedGroup[] = [
      ...groups,
      { id: 'azure', title: 'Azure Resources', subgroups: [{ title: 'Resource Graph', permissions: [source] }] },
    ];
    render(<PermissionList groups={list} ticked={new Set([permKey(users), permKey(groupsOnly), permKey(source)])} onToggle={vi.fn()} />);
    expect(screen.getByText(/You lose 1 table: devices/)).toBeTruthy();
    expect(screen.getByText('Resource Graph', { selector: 'span' })).toBeTruthy();
    expect(screen.getAllByText('Admin').length).toBe(3);
  });

  it('show_all_expands_the_table_list', () => {
    const many = perm('Big.Read.All', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    const list: PlannedGroup[] = [{ id: 'graph', title: 'Graph', subgroups: [{ title: 'Big', permissions: [many] }] }];
    render(<PermissionList groups={list} ticked={new Set([permKey(many)])} onToggle={vi.fn()} />);
    expect(screen.queryByText(/f, g, h/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'show all' }));
    expect(screen.getByText(/a, b, c, d, e, f, g, h/)).toBeTruthy();
  });
});
