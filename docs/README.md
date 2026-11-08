# Documentation

- [install.md](install.md): downloading, installing and first run on Windows, macOS and Linux, where data lives, and
  verifying downloads.
- [EntraPermissions.md](EntraPermissions.md): what the default sign-in can read, and how to set up your own Entra ID app
  registration.
- [LicensesAndPermissions.md](LicensesAndPermissions.md): Graph tables and columns that need a license or extra permission,
  and how Kustodian leaves them out instead of failing.
- [external-tools.md](external-tools.md): running your own commands on result rows from the Run tool menu.
- [workbooks.md](workbooks.md): pages of chart, table, stat and Markdown widgets that share parameters.
- [solutions.md](solutions.md): ready-made queries and workbooks to install from the Solutions panel, and how to add one.
- [manual-checks.md](manual-checks.md): the manual verification checklist per platform, and its results.
- [releasing.md](releasing.md): cutting a release, changelog entries, the deploy key and the rulesets.
- [design/specs](design/specs): design specs. [2026-10-21-kustodian-design.md](design/specs/2026-10-21-kustodian-design.md) is
  the main one.
- [design/plans](design/plans): implementation plans, in order. They are a historical record and keep the paths and names of
  the time they were written.
- [design/mockups](design/mockups): HTML mockups of each screen. `studio.css` holds the design tokens the web UI's
  `styles.css` is based on.

## Relationships

Some Graph tables have relationship columns: `users.memberOf`, `users.manager`, `users.directReports`, `users.ownedObjects`,
`users.registeredDevices`, `users.ownedDevices`, `groups.members`, `groups.owners`, `servicePrincipals.owners`,
`applications.owners`, `devices.registeredOwners` and `devices.registeredUsers`. Each holds a list of the objects the row is
related to (`manager` holds one). An entry has `id`, `objectType` (such as `group` or `user`), `displayName`,
`userPrincipalName`, `mail`, `appId` and `deviceId`.

Two more `users` columns read something other than directory objects:

- `authenticationMethods`: the user's registered sign-in methods (`GET /users/{id}/authentication/methods`). An entry has
  `objectType` (such as `fido2AuthenticationMethod` or `passwordAuthenticationMethod`), `id`, `createdDateTime`, and the
  fields of its type: `displayName`, `aaGuid` and `model` for a FIDO2 key, `phoneNumber` for a phone, and so on. A field
  that doesn't apply to an entry's type is absent. Needs `UserAuthenticationMethod.Read.All`.
- `authenticationRequirements`: one object, not a list (`GET /users/{id}/authentication/requirements`), with
  `perUserMfaState` (`disabled`, `enforced` or `enabled`). Needs `Policy.Read.All`.

Graph can't list these for a whole table, so Kustodian reads them one object at a time, and only when your query names the
column. Use `mv-expand` to get one row per entry.

The groups a user is a member of:

```kql
users
| where userPrincipalName == "someone@contoso.com"
| mv-expand g = memberOf
| where g.objectType == "group"
| project group = tostring(g.displayName), groupId = tostring(g.id)
```

The members of a group:

```kql
groups
| where displayName == "SOC Analysts"
| mv-expand m = members
| project name = tostring(m.displayName), upn = tostring(m.userPrincipalName), type = tostring(m.objectType)
```

The FIDO2 keys of some accounts, and their per-user MFA state:

```kql
users
| where userPrincipalName in ("bg1@contoso.com", "bg2@contoso.com")
| mv-expand m = authenticationMethods
| where m.objectType == "fido2AuthenticationMethod"
| summarize keys = count(), models = make_set(tostring(m.model)), mfa = take_any(tostring(authenticationRequirements.perUserMfaState))
    by userPrincipalName
```

Limits:

- Relationships are read for at most 100 objects per column and table. When more than 100 objects are listed, none of them
  have the relationship read, and the values are empty.
- At most 1,000 entries are kept per object.
- Only direct relationships are read. A group's members don't include members of its nested groups, and `memberOf` doesn't
  include groups reached through other groups.

You may see these notices after a run:

- A column was cut off at the entry cap for some objects. Their lists are incomplete.
- There were too many objects (more than 100). Nothing was read for that column, and the values are empty. Filter first.
- The filter ran locally. Every listed object's relationships were read before the filter was applied, or, over the cap,
  every listed object counted toward it.
- No permission. The signed-in account can't read that relationship, and the values are empty. The notice names the
  permissions that would allow it.
- Entries without details. Graph lists an entry whose type the account can't read (a service principal among a group's
  members, say) with only its ID and type, so its name is empty. The notice names the permissions that would show it.

Filter with something Graph can apply, such as `==` or `startswith`, before the query reads a relationship column. That keeps
the number of objects small, so the read is quick and stays under the cap.

## Derived types

Some Graph collections hold objects of several types. `policies_authenticationMethodsPolicy_authenticationMethodConfigurations`
lists a `fido2AuthenticationMethodConfiguration`, an `smsAuthenticationMethodConfiguration` and so on, and
`identity_conditionalAccess_namedLocations` lists IP and country locations. Such a table has the base type's columns, then
the derived types' own properties, then `odataType`:

- A derived column is empty on rows of other types. Its description starts with the types that have it ("Only on
  fido2AuthenticationMethodConfiguration.").
- `odataType` is the row's type, `@odata.type` without its `#` (`microsoft.graph.fido2AuthenticationMethodConfiguration`).
  Use it to keep one type's rows.
- When two derived types have a property with the same name and different types, the column is `dynamic`.
- Graph can't select, filter or sort a collection by a derived type's property. A query that uses a derived column reads the
  table without `$select`, so Graph sends each object's default properties, and its `where` and `sort` on derived columns
  run locally. A property Graph returns only when selected is then empty. `odataType` alone keeps the `$select`.
- A table whose derived types would add more than 200 columns (`deviceManagement_deviceConfigurations`, `directoryObjects`)
  gets only `odataType`.
- A derived type's navigation properties aren't columns, except those Graph returns inline in the list: the method
  configurations' `includeTargets`.

The FIDO2 method policy:

```kql
policies_authenticationMethodsPolicy_authenticationMethodConfigurations
| where odataType == "microsoft.graph.fido2AuthenticationMethodConfiguration"
| project state, includeTargets, keyRestrictions, isAttestationEnforced
```

## Single objects

Some Graph paths hold one object, not a list: tenant settings and policies such as
`policies/identitySecurityDefaultsEnforcementPolicy`, `policies/authenticationMethodsPolicy` or
`policies/defaultAppManagementPolicy`. Each is a table with one row, named like the others (`/` becomes `_`):

```kql
policies_identitySecurityDefaultsEnforcementPolicy
| project isEnabled
```

`me` is one too: the signed-in user, with the columns of `users`, including those Graph returns only when one user is read
(`aboutMe`, `mailboxSettings`). The collections under it (`me/messages`, `me/events`) aren't tables.

Kustodian reads one with a single request that selects the columns the query uses. Graph doesn't filter, sort or page a
single object, so `where`, `take` and `count` run locally on the one row. Only the single objects that Microsoft lists a
read permission for are tables; the rest are containers with nothing of their own to read.

Columns that hold a secret or a credential's content are left out of these tables: a certificate's password or raw content, an
enrollment token, the Apple push notification certificate. The list is kept by hand (`GraphSchemaBuilder.SecretColumns`), and
the daily schema update flags new columns that look like a secret for review.
