# Working in Kustodian

## Warnings

Warnings are always fixed, never suppressed. That covers compiler and analyzer warnings (`dotnet build -warnaserror` must pass),
`oxlint` and `tsc`. No `#pragma warning disable`, `[SuppressMessage]`, `<NoWarn>`, `oxlint-disable`, `@ts-ignore` /
`@ts-expect-error`, raised warning limits, or rule severities lowered in config, unless the owner has explicitly allowed that one.

Known open warnings (owner's decision, 2026-10-21):

- `react(incompatible-library)` from oxlint on TanStack Table's `useReactTable` (`web/src/results/result-grid.tsx`). It stays
  until TanStack Table v9, which is built for the React Compiler. Don't suppress it.
- Vite's chunk-size warning (over 500 kB) for the lazily loaded Monaco editor chunk. It is local and loaded on demand. Don't
  raise `build.chunkSizeWarningLimit`.

Anything else that seems to need a suppression: ask first, with the options.
