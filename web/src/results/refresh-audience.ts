import type { Source } from '../wire';

/** Whose token a refused run of the source refreshes. */
export const refreshAudience: Record<Source, 'graph' | 'arm' | 'logs'> = {
  graph: 'graph',
  raw: 'graph',
  hunting: 'graph',
  arg: 'arm',
  logs: 'logs',
};
