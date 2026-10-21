import type { ReactNode } from 'react';

export type PanelName = 'schema' | 'saved' | 'recent' | 'snippets';

const icon = (paths: ReactNode) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    {paths}
  </svg>
);

/** The rail's buttons, as the Main mockup draws them. `label` is the button's name; `title` the panel's. */
export const PANELS: { name: PanelName; label: string; title: string; icon: ReactNode }[] = [
  {
    name: 'schema',
    label: 'Schema',
    title: 'Schema',
    icon: icon(
      <>
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
        <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
      </>,
    ),
  },
  { name: 'saved', label: 'Saved queries', title: 'Saved', icon: icon(<path d="M6 3h12v18l-6-4-6 4z" />) },
  {
    name: 'recent',
    label: 'Recent runs',
    title: 'Recent',
    icon: icon(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>,
    ),
  },
  {
    name: 'snippets',
    label: 'Snippets',
    title: 'Snippets',
    icon: icon(
      <>
        <path d="M8 7l-5 5 5 5" />
        <path d="M16 7l5 5-5 5" />
      </>,
    ),
  },
];
