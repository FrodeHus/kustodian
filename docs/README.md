# Documentation

- [install.md](install.md): downloading, installing and first run on Windows, macOS and Linux, where data lives, and
  verifying downloads.
- [EntraPermissions.md](EntraPermissions.md): what the default sign-in can read, and how to set up your own Entra ID app
  registration.
- [LicensesAndPermissions.md](LicensesAndPermissions.md): Graph tables and columns that need a license or extra permission,
  and how Kustodian leaves them out instead of failing.
- [manual-checks.md](manual-checks.md): the manual verification checklist per platform, and its results.
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
