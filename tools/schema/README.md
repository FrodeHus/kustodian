# Schema tool

Regenerates `GraphSchema/graph-beta.json`, the Graph beta schema embedded in the app, and prints what changed.
It also writes `graph-permissions.json` and `manifest.json` beside it (see Outputs). Once they are on main, the app downloads
them on its next start, without a new release (`GraphSchemaUpdates`).

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
- `manifest.json`: the format number (`GraphSchemaManifest.CurrentFormat`), the schema's `generatedAt` and both files' SHA-256
  and size, written on every run when both files are in one folder under their usual names. The app downloads a schema only
  when the format is one it reads and the date is newer than its own, so raise `CurrentFormat` when a change to
  `GraphSchemaJson` or `GraphPermissionCatalog` would break older builds.

## Relationship columns

`src/Kustodian.Graph/Schema/graph-relationships.json` lists, per table, the navigation properties exposed as relationship
columns (`users.memberOf`, `groups.members`, ...): table name, then relationship name, each with `{}`, or with
`{"path": "authentication/methods"}` when the column reads a path under the object other than its own name. Only direct
relationships belong there, except `users.transitiveMemberOf` (Conditional Access evaluates nested groups); no other
`transitive*`, since nested reads are what gets a large tenant throttled. The tool walks the path through the metadata (navigation properties, and a
complex-typed property as the last segment) and turns each into a get-only `dynamic` column, with the delegated permissions
Microsoft lists for `GET /{table}/{id}/{path}`; one with none gets a warning in the output. Its entries are
`kustodian.directoryObjectRef` when the target is a directory object; `kustodian.{type}` (`objectType`, then the properties of
the type and its derived types) for other entities; the complex type itself for a property. A path segment that isn't in the
metadata, a collection before the last segment, or a table the metadata doesn't have stops the run with exit code 3.

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

## Single objects and secret columns

A singleton (`me`) or a single-valued contained navigation (`policies/identitySecurityDefaultsEnforcementPolicy`) becomes a
one-row table (`"single": true`) only when Microsoft lists a delegated read permission for its path. Paths under `me`
(`me/messages`, `education/me/...`) are left out.

Columns that hold a secret or a credential's content are left out of their table by `GraphSchemaBuilder.SecretColumns`, a
hand-kept list. To catch new ones, the tool prints `Possible secret column: table.column` for every column new since the
committed schema whose name or description looks like a password, secret, token, private key, credential or certificate
(`GraphSchemaDiff.LooksSecret`). It only flags them. The graph-schema workflow lists them under "Possible secret columns:
review before merging" in its pull request; add the real ones to `SecretColumns`.
