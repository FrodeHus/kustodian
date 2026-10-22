import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSchemas } from '../schema/schema-store';
import type { LicenseInfo, SchemaLicenses } from '../wire';
import { neededLicenses } from './needed-licenses';
import { TenantLicenses } from './tenant-licenses';

const bridge = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call: bridge.call,
}));

const p1: LicenseInfo = {
  license: 'Microsoft Entra ID P1 or P2',
  plans: ['AAD_PREMIUM', 'AAD_PREMIUM_P2'],
  source: 'https://learn.microsoft.com/a',
  state: 'available',
};
const intune: LicenseInfo = { license: 'Microsoft Intune', plans: ['INTUNE_A'], source: 'https://learn.microsoft.com/b', state: 'missing' };
const contoso: SchemaLicenses = {
  known: true,
  reason: null,
  tables: { auditLogs_signIns: p1, deviceManagement_managedDevices: intune },
  columns: { users: { signInActivity: p1 } },
};

beforeEach(() => {
  bridge.call.mockReset();
  useSchemas.getState().reset();
});

describe('TenantLicenses', () => {
  it('lists_each_license_once_with_what_needs_it', () => {
    expect(neededLicenses(contoso)).toEqual([
      { info: p1, needs: ['auditLogs_signIns', 'users.signInActivity'] },
      { info: intune, needs: ['deviceManagement_managedDevices'] },
    ]);
  });

  it('reads_the_licenses_when_not_read_yet_and_shows_whether_the_tenant_has_them', async () => {
    bridge.call.mockResolvedValue(contoso);
    render(<TenantLicenses accountKey="k1" />);

    expect(await screen.findByLabelText('Microsoft Entra ID P1 or P2: The tenant has it.')).toBeTruthy();
    expect(screen.getByLabelText("Microsoft Intune: The tenant doesn't have it.")).toBeTruthy();
    expect(bridge.call).toHaveBeenCalledWith('schema.licenses', { source: 'graph', refresh: false });
  });

  it('refresh_reads_them_from_graph_again', async () => {
    useSchemas.setState({ licenses: contoso });
    bridge.call.mockResolvedValue({ ...contoso, tables: { ...contoso.tables, deviceManagement_managedDevices: { ...intune, state: 'available' } } });
    render(<TenantLicenses accountKey="k1" />);
    expect(bridge.call).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByLabelText('Microsoft Intune: The tenant has it.')).toBeTruthy();
    expect(bridge.call).toHaveBeenCalledWith('schema.licenses', { source: 'graph', refresh: true });
  });

  it('says_why_when_the_licenses_are_unknown', async () => {
    bridge.call.mockResolvedValue({ known: false, reason: 'The account can’t read the tenant’s licenses.', tables: {}, columns: {} });
    render(<TenantLicenses accountKey="k1" />);

    expect(await screen.findByText('The account can’t read the tenant’s licenses.')).toBeTruthy();
  });

  it('says_so_when_the_read_fails', async () => {
    bridge.call.mockRejectedValue(new Error('offline'));
    render(<TenantLicenses accountKey="k1" />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toHaveProperty('disabled', false));
    expect(screen.getByText('The tenant’s licenses couldn’t be read.')).toBeTruthy();
  });
});
