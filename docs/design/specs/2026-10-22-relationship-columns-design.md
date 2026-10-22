# Relationship columns: design

Date: 2026-10-22. Status: for the owner's review.

**Owner** means the owner decided it. **My call** means I chose it and the owner can overrule it while reading.

## 1. Why

A Graph user has relationships that aren't properties: the groups it is a member of (`/users/{id}/memberOf`), its manager,
the devices it registered. A group has its members and owners. Kustodian reads only properties, so today the only way to
answer "which groups is this user in?" is the Raw tab, one request at a time, then "Open as KQL tab".

The moment this came from (**Owner**): starting from one known user and wanting to see their group memberships. The same
question in reverse, listing a group's members, is the second case. The design must cover other relationships of the same
kind without new code for each.

## 2. Goals

- `users | where userPrincipalName == "…" | mv-expand g = memberOf` lists a user's direct groups.
- `groups | where displayName == "…" | mv-expand m = members` lists a group's members.
- One mechanism for every relationship on a curated list; adding a relationship is a line in a JSON file and a schema
  regeneration, not code.
- Completion works on the expanded entries (`g.displayName`, `m.userPrincipalName`).
- Built-in snippets for these queries (**Owner**).

## 3. Non-goals

- Transitive relationships (`transitiveMemberOf`, `transitiveMembers`). Direct is enough, and nested reads are what gets a
  large tenant throttled (**Owner**).
- Reading every entry of a very large relationship. Entries are cut off at a cap; a user who needs more rewrites the query
  (**Owner**).
- Sending a filter on the entries to Graph (`$filter` on `/memberOf`). Filters on entries run locally after `mv-expand`
  (**My call**: the entries are already capped, so the saving is small and the translator work is not).
- A relationship of a relationship (the groups of each member of a group). The entries are references, not rows of
  `users` or `groups`; join back to those tables when more is needed.
- Mailbox, calendar, files and Teams content (`messages`, `events`, `drive`, …), which are navigation properties too.
- Adding relationship permissions to the Create Entra ID application planner (**My call**: a follow-up if wanted).

## 4. Anti-goals

- New syntax that looks like KQL but behaves differently: no `memberOf(user)` function. A KQL function is evaluated row by
  row with no I/O; the planner would have to special-case the call, and each relationship would need its own function or a
  string-typed generic one completion can't check.
- A table per relationship (`users_memberOf`). It must always be joined back, and on its own it has nothing to narrow it,
  so the planner would need to push `users` filters across a join. It also doubles the schema and completion lists.
- A query that quietly fans out over the whole tenant. Relationship reads are bounded by the existing per-object cap and
  the relationship object cap (100) and the run's byte budget, and every cut is shown to the user.

## 5. The model

### 5.1 Relationship columns

A relationship is a column on the table it belongs to, holding the related objects for that row:

| Kind | KQL type | Value |
|---|---|---|
| collection (`memberOf`, `members`) | `dynamic` array | one entry per related object |
| single (`manager`) | `dynamic` bag | the related object, or null when there is none |

A relationship column is read one object at a time, and only when the query names it. This is the existing rule for
get-only columns (`Unreadable = Named ∩ !Listable` in `GraphQueryPlanner.PlanExplained`): never through `*`, `search`,
`pack_all` or pass-through. The leading `where` on the table is pushed to Graph as today, so only the rows that pass are
read one at a time.

```kql
users
| where userPrincipalName == "frode@contoso.com"
| mv-expand g = memberOf
| where g.objectType == "group"
| project group = tostring(g.displayName), groupId = tostring(g.id)
```

```kql
groups
| where displayName == "SOC Analysts"
| mv-expand m = members
| project tostring(m.displayName), tostring(m.userPrincipalName), tostring(m.objectType)
```

### 5.2 Entry shape

Directory relationships return mixed types (`memberOf` holds groups, directory roles and administrative units; `members`
holds users, groups, service principals, devices and contacts). Every entry has one shape, `kustodian.directoryObjectRef`,
added to `complexTypes` so completion knows it (**My call**):

| Field | From |
|---|---|
| `id` | all |
| `objectType` | `@odata.type` without `#microsoft.graph.`: `group`, `user`, `directoryRole`, `servicePrincipal`, … |
| `displayName` | all that have it |
| `userPrincipalName`, `mail` | users (`mail` also groups) |
| `appId` | service principals, applications |
| `deviceId` | devices |

A field the object's type doesn't have is absent. `objectType` replaces `@odata.type` so queries don't need
`g["@odata.type"]` and the long prefix (**My call**).

### 5.3 The curated list

A new hand-kept file, `src/Kustodian.Graph/Schema/graph-relationships.json`, next to `graph-areas.json`, keyed by table
then relationship (**Owner**: curated, starting set below):

```json
{
  "users": { "memberOf": {}, "manager": {}, "directReports": {}, "ownedObjects": {}, "registeredDevices": {}, "ownedDevices": {} },
  "groups": { "members": {}, "owners": {} },
  "servicePrincipals": { "owners": {} },
  "applications": { "owners": {} },
  "devices": { "registeredOwners": {}, "registeredUsers": {} }
}
```

The empty objects leave room for per-relationship settings (a different cap, say) without a format change. The schema
tool (`tools/schema`) reads the file and:

- checks that each name is a `NavigationProperty` on the table's entity type in the CSDL, and fails the run if not, so the
  list can't drift from Graph silently;
- takes collection or single from the CSDL type (`Collection(…)` or not);
- takes the description from the CSDL or the external descriptions, as for properties;
- takes every read-only delegated permission `permissions.json` grants GET on `/{table}/{id}/{relationship}`
  (`GraphPermissions.ReadRelationshipDelegated`): least-privileged first, then the rest ordinally, without `User.Read`
  (Microsoft's least-privileged entry for the signed-in user's own relationships, which every account has);
- writes the column into `graph-beta.json` with `listable: false`, `collection`, `complexType:
  "kustodian.directoryObjectRef"`, a new `relationship: true` flag and a new `permissions` array on the column
  (**My call**: `knownPermission` is a single hand-kept string and stays as it is). When `permissions.json` has no entry
  for the relationship's path, the tool emits no permissions and prints a warning; the denied message then falls back
  to the table's docs link, as `NoPermissionMessage` does for tables.

`GraphMetadata.Build` today drops every navigation property (it reads only `Property` elements, `GraphMetadata.cs:74`);
it needs to keep them, flagged, for the tool to check against. `GraphSchemaDiff` reports added and removed relationship
columns like any other column.

### 5.4 Reading

Relationships get their own reader beside `GraphBatchReader` (or an extension of it; **builder's call**), called from
`GraphCollectionReader.ReadPerObjectAsync` for the named relationship columns.

- **Request:** one `$batch` item per object per relationship: collection
  `GET /{path}/{id}/{relationship}?$select=id,displayName,userPrincipalName,mail,appId,deviceId&$top=999`, single
  `GET /{path}/{id}/{relationship}?$select=…`. Same batch size, concurrency and single throttling retry as today.
- **Body:** a collection's `value` array becomes the column's entries; a single relationship's body becomes the bag. A
  404 on a single relationship (a user with no manager) is a null value, not a failure.
- **Paging:** a body with `@odata.nextLink` is followed (same https/graph.microsoft.com check as `ReadPagesAsync`) until
  the object has `GraphLimits.RelationEntriesPerObject` entries, **1,000** by default (**Owner**: cut off at a cap; number is
  **my call**). Whether follow-up pages go in later `$batch`es or as plain GETs is the builder's call.
- **Objects:** relationships have their own, lower cap, `GraphLimits.RelationshipObjectsPerTable`, **100** by default
  (**Owner**), applied to each relationship column instead of `PerObjectReadsPerTable` (2,000). Over it the column stays
  empty, as with the existing cap, and the existing "too many objects to read one at a time" notice shows. Reads are not
  refused when the filter wasn't sent to Graph (**Owner**); the cap is what bounds them.
- **Budget:** every item body and follow-up page is charged to the run's `GraphFetchLease`, as today.
- **Cache:** values are cached per object for `PerObjectCacheTtl` (30 minutes) like other per-object columns, one entry
  per object and relationship, never mixed with property values (**My call**: the reads are separate URLs anyway). The
  key must not collide with a get-only property of the same name (a `rel:` prefix in the columns part of the key, say).
  The stored JSON carries the entries and whether they were truncated, so a cache hit still reports truncation.
  `IGraphObjectCache`'s interface doesn't change.
- **`$select`:** build with it from the start (**My call**). If the owner's tenant check (section 8) shows Graph refusing
  it on a relationship, that relationship drops `$select`.

### 5.5 What the user is told

Additions to `TableFetch` in `RunResult` and the chips in `web/src/results/run-status.tsx`:

- **Truncated:** "`groups.members`: cut off at 1,000 entries for 2 objects." Per relationship, with the count of objects
  cut.
- **Filter not applied by Graph** (**Owner**): when a relationship column is read and the table's rows weren't narrowed
  by Graph alone — part of the leading `where` stays local (`contains`, a later `where`), Graph refused the filter
  (`Unfiltered`), or the table is self-joined — a chip says the relationship was read for every listed object: "`users.memberOf`
  read for all 87 listed users; the filter ran locally. Use a filter Graph can apply (`==`, `startswith`) to read fewer."
- **Denied:** when Graph answers 403 for every read of a relationship, the column is listed as denied with its
  permissions: "No permission to read `users.memberOf`; it needs one of: GroupMember.Read.All, Group.Read.All,
  Directory.Read.All." When only some objects are refused, the values that were read are kept and the chip says so:
  "`users.memberOf`: no permission for 3 of 40 objects, their values are empty." This is a new field on `TableFetch`
  carrying the relationship, the refused count and the permissions, not the existing `Denied` list, which is fed by
  property probing and remembered in the probe cache; relationship denials are not remembered across runs. Today a 403
  inside `$batch` is only counted in `PerObjectFailed`; for relationships it must be named (**My call**, all of this
  bullet).
- **Read one at a time:** the existing "N columns read one object at a time" chip counts relationship columns too.
- **Progress:** the existing `per-object` run events name the relationship.

### 5.6 Explain

The table's Explain entry lists each relationship column it will read, with the request template
(`/users/{id}/memberOf?$select=…&$top=999`), its permissions and the entry cap, and says when the filter will run
locally so every listed object is read. `ExplainLimits` gains the entry and relationship object caps.

## 6. Snippets

New built-in graph snippets in `builtin-snippets.json`, group **"Directory relationships"**, ids continuing the
`5f0e6a6e-6d0a-4a55-9a53-0b7e3a1c00NN` series (**My call** on the third and on the group name):

| Name | Parameter | Text |
|---|---|---|
| Groups a user is a member of | `upn` (string, required) | `users \| where userPrincipalName == "{upn}" \| mv-expand g = memberOf \| where g.objectType == "group" \| project group = tostring(g.displayName), groupId = tostring(g.id), mail = tostring(g.mail)` |
| Members of a group | `groupName` (string, required) | `groups \| where displayName == "{groupName}" \| mv-expand m = members \| project name = tostring(m.displayName), upn = tostring(m.userPrincipalName), type = tostring(m.objectType), id = tostring(m.id)` |
| Owners of an application | `appName` (string, required) | `applications \| where displayName == "{appName}" \| mv-expand o = owners \| project name = tostring(o.displayName), upn = tostring(o.userPrincipalName), type = tostring(o.objectType)` |

`SnippetServiceTests.Builtin_graph_snippets_all_plan_without_error` asserts four graph snippets, all in "Identity checks";
it changes to cover the new count and group, and the new snippets must plan without error like the others.

## 7. Code layout

| Area | Change |
|---|---|
| `tools/schema`, `GraphMetadata` | keep navigation properties; read `graph-relationships.json`; emit relationship columns and `kustodian.directoryObjectRef` |
| `GraphSchema`, `GraphSchemaJson` | `GraphColumn.Relationship` (and `Single` or reuse `Collection`); read/write the flag |
| `GraphGlobals.Typed` | type relationship columns from the shape so completion works; `Plain` already gives `dynamic` |
| `GraphQueryPlanner` | nothing new beyond carrying relationship columns into `Unreadable` (they are `listable: false`) |
| `Fetch/` | relationship reads, paging, cap, cache key; `GraphCollection` gains truncation and denied relationships |
| `GraphRunner`, `RunResult` | carry truncation and denial to `TableFetch` |
| `GraphExplain` | relationship requests, permissions and cap |
| `web/src/results/run-status.tsx` | truncated and denied chips |
| `builtin-snippets.json`, its tests | the snippets above |
| `docs/` | a short section on relationship columns in the query docs |

## 8. Testing and verification

**Unit**, with the fake HTTP handlers the Graph tests already use:

- the schema tool fails on a curated name that isn't a navigation property, and emits the column with the right kind,
  description and permissions;
- a query naming `memberOf` reads it per object for the filtered rows only; a query that doesn't name it (including
  `project *`) sends no relationship reads;
- entries are mapped to the shape, `objectType` is derived, missing fields are absent;
- paging stops at the cap and the truncation is reported, also from the cache;
- a 404 on `manager` is null; a 403 marks the relationship denied with its permissions;
- bytes are charged to the lease; over 100 objects the column is empty and capped;
- a local `contains` filter, a refused filter and a self-join each show the filter-not-applied chip; an exact `==` filter
  doesn't;
- completion offers the shape's fields after `mv-expand g = memberOf | where g.`;
- the snippets plan without error.

**Manual, by the owner**, on a real tenant: a user's groups; a large group's members (truncation chip); a user without a
manager; a signed-in account without `GroupMember.Read.All` (denied chip). Graph's handling of `$select` with derived-type
fields (`userPrincipalName`, `appId`) on mixed directory-object collections must be checked here; if Graph refuses it,
drop `$select` for that relationship and keep only the shape's fields.

## 9. What is left to the builder

- Whether relationship reads extend `GraphBatchReader` or live in a new reader.
- How follow-up pages are sent (inside later `$batch`es or as plain GETs).
- The exact cache key form, as long as it can't collide with property columns.
- Wording of chips and Explain text, following the existing ones.

## 10. Safety rules for building it

- GET only. Relationship reads never write.
- Follow `@odata.nextLink` only to https on graph.microsoft.com, as list paging does.
- Never read a relationship the query doesn't name.
- No warning suppressions (`CLAUDE.md`).
