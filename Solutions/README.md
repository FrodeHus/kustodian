# Solutions

Community Solutions: queries and workbooks that Kustodian offers to install. The app reads `index.json` from this folder on
GitHub. The owner reviews every pull request that touches it.

## Layout

```
Solutions/
  index.json                  generated, never edited by hand
  <solution-id>/
    solution.json             the manifest
    README.md                 what it does and what it needs
    queries/<query-id>.json   a saved query, as the library stores it but without id and timestamps
    workbooks/<id>.json       a workbook, in the form Kustodian saves it
    tools.json                only when the manifest lists tools
```

## solution.json

| Field | Meaning |
| --- | --- |
| `version` | Always `1`. |
| `id` | The folder name. 3 to 64 lowercase letters, digits and hyphens, not starting or ending with a hyphen. |
| `name`, `description`, `author` | Shown in the catalog. |
| `solutionVersion` | `x.y.z`. Raise it with every change to the solution, or installed copies are never offered the update. |
| `support` | `kustodian` or `community`. |
| `categories` | Free-form labels. |
| `sources` | The sources its queries use: `graph`, `hunting` or `arg`. |
| `minAppVersion` | `x.y.z`, the oldest app that can install it. It cannot be above the next release. |
| `requires` | Optional: `graph` permissions, `roles`, `licenses` and `azure` access it needs. |
| `content` | The `queries`, `workbooks` and `tools` it ships, by id. Each query and workbook id is a valid id and has a file. |

A workbook links its queries with `query.saved.id` set to the query's id, not a GUID.

## What CI checks

A valid manifest, exactly the files the manifest lists, queries that the library accepts and that parse, workbooks the app
accepts in the form it writes, no GUID other than a workbook's own `id` and its widget ids, no e-mail address, and an
up-to-date `index.json`. Widget queries parse too, and Graph queries, in query files and in widgets, are checked against
the app's Graph schema and planned as a run would plan them. Workbook widgets have no tool buttons yet: tool buttons in
solution workbooks come with tool support. A changed solution must raise its `solutionVersion` (the
`solutionVersion bumped` check).

## Regenerating the index

Run this after every change in this folder and commit the result:

```
KUSTODIAN_WRITE_SOLUTIONS_INDEX=1 dotnet test tests/Kustodian.Tests --filter IndexIsCurrent
```
