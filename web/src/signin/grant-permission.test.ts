import { describe, expect, it } from 'vitest';
import type { AccountInfo, ClientKind } from '../wire';
import { grantOffer } from './grant-permission';

const account = (clientKind: ClientKind, scopes: string[]): AccountInfo => ({
  key: 'k1',
  username: 'ola@contoso.com',
  tenantName: 'Contoso',
  tenantId: 't1',
  clientId: 'c1',
  clientKind,
  active: true,
  expired: false,
  scopes,
});
const graphCli = (scopes: string[]) => account('graphCli', scopes);
const azureCli = (scopes: string[]) => account('azureCli', scopes);
const own = (scopes: string[]) => account('own', scopes);

describe('grantOffer', () => {
  it('offers the first read permission to a graph cli account', () =>
    expect(grantOffer(graphCli([]), ['Reports.Read.All', 'AuditLog.Read.All'], 'graph')).toEqual({ scope: 'Reports.Read.All' }));
  it('offers nothing without an account', () => expect(grantOffer(undefined, ['Reports.Read.All'], 'graph')).toBeNull());
  it('offers nothing to azure cli', () => expect(grantOffer(azureCli([]), ['Reports.Read.All'], 'graph')).toBeNull());
  it('offers nothing for resource graph or raw', () => {
    expect(grantOffer(own([]), ['x.Read.All'], 'arg')).toBeNull();
    expect(grantOffer(own([]), ['x.Read.All'], 'raw')).toBeNull();
  });
  it('offers nothing for write-only or empty lists', () => {
    expect(grantOffer(graphCli([]), ['User.ReadWrite.All'], 'graph')).toBeNull();
    expect(grantOffer(graphCli([]), [], 'graph')).toBeNull();
  });
  it('skips a write permission for the read one after it', () =>
    expect(grantOffer(graphCli([]), ['User.ReadWrite.All', 'User.Read.All'], 'graph')).toEqual({ scope: 'User.Read.All' }));
  it('says the permission is held, in any casing', () =>
    expect(grantOffer(graphCli(['reports.read.all']), ['Reports.Read.All'], 'graph')).toEqual({ held: 'Reports.Read.All' }));
  it('says a held write permission is held, ahead of the read one', () =>
    expect(grantOffer(graphCli(['user.readwrite.all']), ['User.Read.All', 'User.ReadWrite.All'], 'graph')).toEqual({ held: 'User.ReadWrite.All' }));
  it('says a held write-only permission is held', () =>
    expect(grantOffer(graphCli(['User.ReadWrite.All']), ['User.ReadWrite.All'], 'graph')).toEqual({ held: 'User.ReadWrite.All' }));
  it('offers threat hunting for hunting', () =>
    expect(grantOffer(own([]), ['ThreatHunting.Read.All'], 'hunting')).toEqual({ scope: 'ThreatHunting.Read.All' }));
});
