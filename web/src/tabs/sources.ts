import type { Source } from '../wire';

/** Each source's badge (spec 6.1: GR, AH, ARG), its colour class and its name. */
export const SOURCES: Record<Source, { badge: string; className: string; name: string }> = {
  graph: { badge: 'GR', className: 'graph', name: 'Microsoft Graph' },
  hunting: { badge: 'AH', className: 'hunt', name: 'Defender advanced hunting' },
  arg: { badge: 'ARG', className: 'arg', name: 'Azure Resource Graph' },
  raw: { badge: 'GR', className: 'graph', name: 'Raw Graph request' },
};
