# Schema tool

Regenerates `src/Kustodian.Graph/Schema/graph-beta.json`, the Graph beta schema embedded in the app, and prints what changed.
It also writes `graph-permissions.json` beside it (see Outputs).

```
dotnet run --project tools/schema -- [--metadata <path|url>] [--permissions <path|url>] [--out <path>] [--permissions-out <path>]
```

With no arguments it downloads both inputs. Set `GITHUB_TOKEN` to avoid API rate limits when resolving the metadata commit.
Exit codes: 0 ok, 2 usage, 3 an input could not be read or downloaded.

## Outputs

- `graph-beta.json` (`--out`): the schema. Not rewritten when nothing changed.
- `graph-permissions.json` (`--permissions-out`, default beside the schema path): every `DelegatedWork` permission whose path
  sets include `GET` on a table's path, whatever the least-privileged marker, with admin consent, Microsoft's `userDescription`
  and the table paths it can read (`GraphPermissionCatalog`). Permissions that read no table are left out. It is written on
  every run, even when the schema is unchanged, and the tool prints `Permissions: N`. The Create Entra ID application dialog
  offers these; write permissions are filtered out there, not here.

## Inputs

1. **Metadata** (`--metadata`): `clean_beta_metadata/cleanMetadataWithDescriptionsAndAnnotationsbeta.xml` in
   `microsoftgraph/msgraph-metadata`, fetched at the commit `master` points to. The commit is recorded in the file's `source`.
2. **Permissions** (`--permissions`), default
   `https://raw.githubusercontent.com/microsoftgraph/microsoft-graph-devx-content/master/permissions/new/permissions.json`.
   The `msgraph-metadata` repository has no permissions file; this one, in `microsoftgraph/microsoft-graph-devx-content`, is
   Microsoft's permissions data (schema: `microsoftgraph/kibali`, `specs/permissions-schema.json`).

### Shape of the permissions file

It is keyed by permission, with the API paths inside path sets:

```json
{
  "permissions": {
    "Application.Read.All": {
      "schemes": { "DelegatedWork": {}, "DelegatedPersonal": {}, "Application": {} },
      "pathSets": [
        {
          "schemeKeys": ["DelegatedWork", "DelegatedPersonal", "Application"],
          "methods": ["GET"],
          "paths": { "/applications": "least=DelegatedWork,DelegatedPersonal,Application", "/applications/{id}": "..." }
        }
      ]
    }
  }
}
```

A path's value is empty, or `least=<schemes>` when the permission is the least-privileged one for those schemes.

### How a table gets its permissions

`GraphPermissions.ReadDelegated` inverts the file into path to permissions:

- only the `DelegatedWork` scheme counts (work and school accounts; `DelegatedPersonal` and `Application` do not): the path set's
  `schemeKeys` must include it and the path's value must be `least=` naming it;
- path sets whose `methods` are exactly `["GET"]` win. A read-write permission is marked least-privileged on a path set that also
  lists `POST`; that is least-privileged for writing, not listing. A path that no GET-only set lists falls back to the sets that
  include `GET` among other methods;
- paths are compared case-insensitively with a leading `/`, and every `{...}` placeholder is one segment (`{}`).

A table's `Permissions` are the entries for `/{table.Path}`, sorted and distinct. Many tables get none (Microsoft marks no
least-privileged delegated permission); Explain and the No permission error then fall back to the table's docs link.

`tests/Kustodian.Graph.Tests/Schema/permissions-excerpt.json` is an excerpt of this file for `/applications`, `/users` and
`/auditLogs/signIns` (all permissions listing those paths), in the same shape.

Column permissions are not published by Microsoft: `GraphPermissions.KnownColumns` is a hand-kept list.

Columns Graph returns only on a single object's GET where the metadata doesn't say so (the `users` SharePoint profile columns
and `mailboxSettings`) are marked not listable from `GraphSchemaBuilder.KnownGetOnly`, also a hand-kept list.
