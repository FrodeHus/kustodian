import { describe, expect, it } from 'vitest';
import { AZURE_CLI_CLIENT_ID, type AccountInfo } from '../wire';
import { canCreateApp, canOfferCreateApp } from './permission-plan';

const account = (over: Partial<AccountInfo>): AccountInfo => ({
  key: 'k',
  username: 'kari@contoso.com',
  tenantName: 'Contoso',
  tenantId: 't1',
  clientId: AZURE_CLI_CLIENT_ID,
  active: true,
  expired: false,
  scopes: ['User.Read.All', 'application.readwrite.all'],
  ...over,
});

describe('canCreateApp', () => {
  it('needs a create scope, case-insensitively', () => {
    expect(canCreateApp(account({}))).toBe(true);
    expect(canCreateApp(account({ scopes: ['Directory.AccessAsUser.All'] }))).toBe(true);
    expect(canCreateApp(account({ scopes: ['AppRegistration.Create', 'User.Read.All'] }))).toBe(false);
  });

  it('needs the Azure CLI client and a live token', () => {
    expect(canCreateApp(account({ clientId: 'c0ffee00-0000-0000-0000-000000000001' }))).toBe(false);
    expect(canCreateApp(account({ expired: true }))).toBe(false);
    expect(canCreateApp(undefined)).toBe(false);
  });

  it('the button is offered without the scope check', () => {
    expect(canOfferCreateApp(account({ scopes: [] }))).toBe(true);
  });
});
