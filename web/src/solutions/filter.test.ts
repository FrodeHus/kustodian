import { describe, expect, it } from 'vitest';
import { filterCatalog } from './filter';
import { solution } from './fixtures';

const risky = solution();
const vms = solution(
  {
    id: 'vm-power',
    name: 'VM power hygiene',
    description: 'VMs left running.',
    author: 'someone',
    support: 'community',
    categories: ['Azure'],
    sources: ['arg'],
  },
  { installedVersion: '1.0.0' },
);
const guests = solution({
  id: 'guests',
  name: 'Guest access review',
  description: 'Guests by last sign-in.',
  author: 'kari',
  support: 'community',
  categories: ['Identity', 'Governance'],
  sources: ['graph'],
});
const all = [risky, vms, guests];
const none = { search: '', category: null, source: null, support: null, installed: false } as const;
const ids = (items: typeof all) => items.map((i) => i.manifest.id);

describe('filterCatalog', () => {
  it('no filter keeps everything', () => {
    expect(ids(filterCatalog(all, none))).toEqual(['entra-risky-users', 'vm-power', 'guests']);
  });

  it('search matches name, description, author and category, ignoring case', () => {
    expect(ids(filterCatalog(all, { ...none, search: 'RISKY' }))).toEqual(['entra-risky-users']);
    expect(ids(filterCatalog(all, { ...none, search: 'left running' }))).toEqual(['vm-power']);
    expect(ids(filterCatalog(all, { ...none, search: 'kari' }))).toEqual(['guests']);
    expect(ids(filterCatalog(all, { ...none, search: 'governance' }))).toEqual(['guests']);
  });

  it('each filter alone', () => {
    expect(ids(filterCatalog(all, { ...none, category: 'Identity' }))).toEqual(['entra-risky-users', 'guests']);
    expect(ids(filterCatalog(all, { ...none, source: 'arg' }))).toEqual(['vm-power']);
    expect(ids(filterCatalog(all, { ...none, support: 'kustodian' }))).toEqual(['entra-risky-users']);
    expect(ids(filterCatalog(all, { ...none, support: 'community' }))).toEqual(['vm-power', 'guests']);
    expect(ids(filterCatalog(all, { ...none, installed: true }))).toEqual(['vm-power']);
  });

  it('filters combine', () => {
    expect(ids(filterCatalog(all, { ...none, category: 'Identity', support: 'community' }))).toEqual(['guests']);
    expect(ids(filterCatalog(all, { ...none, source: 'graph', search: 'sign-in' }))).toEqual(['entra-risky-users', 'guests']);
    expect(ids(filterCatalog(all, { ...none, source: 'graph', installed: true }))).toEqual([]);
  });
});
