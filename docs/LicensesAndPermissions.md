# Licenses and permissions per column

A Microsoft Graph table isn't all-or-nothing. You can be allowed to list a table and still not get every column: some
properties need a license the tenant may not have, and some need a permission or role beyond the one that lists the table.
Graph handles these cases inconsistently, so a query that looks right can fail outright, or succeed with columns that are
silently empty. This page explains where that happens and what Kustodian does about it.

For setting up the permissions themselves, see [Entra ID permissions](EntraPermissions.md).

## The problem

Graph reports a missing license or permission in several different ways, depending on the API:

- **The whole request fails.** Selecting one licensed property makes Graph refuse the whole list. A classic example is
  `users` with `signInActivity`, which needs Microsoft Entra ID P1 or P2: without the license, Graph rejects the request even
  though every other user property is readable.
- **The whole table needs a license.** Sign-in logs (`auditLogs/signIns`), Identity Protection (`riskyUsers`,
  `riskDetections`), access reviews, Privileged Identity Management, Intune (`deviceManagement/…`), Global Secure Access
  (`networkAccess/…`) and Microsoft 365 Copilot all answer an error, or nothing, in a tenant without the license.
- **One property needs more permission than the table.** The table lists fine with its least-privileged permission, but
  one selected property answers 401 or 403, and the request fails with it.
- **The value is just empty.** Some properties come back as `null` instead of an error, which is indistinguishable from
  "no data".

Microsoft documents the permissions for each API path, but not per property, and states license requirements only in
prose on each API's page. Nothing machine-readable tells a client up front which columns it will get.

This is Graph-specific. Defender advanced hunting and Azure Resource Graph run the query on the service, which either
answers or refuses the whole query (for example, hunting needs `ThreatHunting.Read.All` and a Defender role). Kustodian
reports those refusals as **No permission**.

## How Kustodian handles it

### It knows which tables and columns need a license

Kustodian ships a hand-kept map of the licenses Graph tables and columns need,
[graph-licenses.json](../src/Kustodian.Graph/Schema/graph-licenses.json). Each entry names the license in Microsoft's words,
the service plans that provide it (any one of them is enough) and the Microsoft Learn page that states the requirement.
Entries without a Learn page as their source are rejected at load time.

### It checks what the tenant has

After you sign in, Kustodian reads `GET /subscribedSkus` to see which service plans the tenant has provisioned in active
subscriptions (enabled or in their grace period). This needs `LicenseAssignment.Read.All` or `Directory.Read.All`. The
answer is cached for 24 hours per account, and read again when you refresh the schema.

If the licenses can't be read (no permission, a timeout), they are **unknown**: Kustodian then assumes nothing is missing and
leaves it to Graph to refuse, as described further down.

### The schema panel shows it

Licensed tables and columns carry a tag in the schema panel:

- **Green**: the tenant has the license.
- **Red**: the tenant doesn't have it. Queries leave it out.
- **Neutral**: the tenant's licenses couldn't be checked. The tooltip says why.

Hover a tag to see the license it needs and the Learn page that says so.

### Unlicensed data isn't requested

When the tenant is known to lack a license, the query planner works around it before anything is sent:

- **A table** that needs the license stops the run with **License missing**, a message naming the license and the Learn page.
  No request is sent.
- **A column** that needs it is left out of `$select` and isn't read object by object. Conditions and sorts on it run
  locally instead of being sent in `$filter` or `$orderby`, so Graph doesn't reject the request. The column stays in the
  result, with empty values, so the query still runs.

**Explain** lists these columns under **Left out for a license**, and after a run the status bar shows a warning naming
them. Nothing is dropped silently.

### Graph's own refusals are worked around

Not everything is in the map, and the tenant's licenses may be unknown. When Graph refuses a request anyway, Kustodian
reacts to the answer:

- **Refused for a license or a feature**: Kustodian sends the request again without the selected columns your query doesn't
  name, and reports them as left out together with Graph's message. If Graph still refuses, the run fails with that message.
- **Refused for permission (401/403) or by a backend that can't serve a property**: Kustodian probes to find which selected
  columns cause it, then reads the table without them. Those columns are reported as **no permission, values empty**. What it
  finds is kept per account for a while, so the next run doesn't probe again.
- **Refused for the whole table**: the run ends with **No permission** and lists the permissions that would allow it, read
  permissions first.

Each step (columns dropped and why, the requests sent) is in the run's **Diagnostics** tab.

## What this means for your results

- An empty column isn't always empty data. Check the warnings in the status bar, or **Explain** before you run.
- A condition on a column that was left out is evaluated on empty values, so `where isnotnull(signInActivity)` returns no
  rows in a tenant without Entra ID P1. That is the honest answer for what can be read, not for what exists.
- The license map covers what Microsoft Learn documents. A license requirement Microsoft doesn't document is caught only when
  Graph refuses the request.
- Your account's own roles still apply. A permission never shows you more than your account could see anyway: a Global
  Reader and a user with no roles can get different results from the same query with the same app.

## Adding to the license map

If you find a table or column that needs a license and isn't in
[graph-licenses.json](../src/Kustodian.Graph/Schema/graph-licenses.json), add an entry with the license, its service plan
names (from Microsoft's [licensing service plan reference](https://learn.microsoft.com/entra/identity/users/licensing-service-plan-reference)),
the Learn page as `source` and the sentence that states it as `quote`. Table keys are Graph paths (a key ending in `/` covers
everything below it); column keys are `path.column`, such as `users.signInActivity`. See [CONTRIBUTING.md](../CONTRIBUTING.md).
