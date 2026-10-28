# Microsoft Graph Command Line Tools client: design

Date: 2026-10-28. Status: for the owner's review.

Marking used below: **Owner** means the owner decided it. **My call** means I chose it on the owner's behalf; it can be changed.
Anything unmarked follows from those two, from the code as it is, or from Microsoft's documentation.

## 1. Why

Kustodian signs in with the Azure CLI's public client by default (`04b07795-8ddb-461a-bbee-02f9e1bf7b46`). That client is a
Microsoft first-party app with pre-authorized permissions: nobody can add to them, and asking it for anything else fails with
`AADSTS65002` instead of a consent screen. So a query such as MFA registration details
(`reports/authenticationMethods/userRegistrationDetails`, `Reports.Read.All`) answers "No permission", and the only way forward
is the user's own app registration.

Microsoft Graph Command Line Tools (`14d82eec-204b-4c2f-b7e8-296a70dab67e`, the client behind `Connect-MgGraph`) is different.
It takes dynamic consent, and many tenants have already granted it broad read permissions because admins use Graph PowerShell.
In the owner's test tenant it already has `Reports.Read.All` (**Owner**), so signing in with it, exactly the way Kustodian signs
in today (`https://graph.microsoft.com/.default`), would have made that query work with no setup.

The people who run Kustodian mostly can't consent to admin-only permissions themselves; they would have to ask an admin
(**Owner**). This feature gives them a second zero-setup client that often reaches more, and a way to consent from a "No
permission" result for those who are allowed to.

## 2. Goals

- A third choice on the sign-in screen: **Microsoft Graph Command Line Tools**, next to **Azure CLI (default)** and **My own
  app registration** (**Owner**).
- Signed in with Graph CLT, Graph tables and advanced hunting use the Graph CLT token. Azure Resource Graph quietly uses an Azure
  CLI token for the same user (**Owner**).
- Signed in with the user's own app registration, that app is used for everything, as today (**Owner**).
- A "No permission" result shows the error as it does today, plus a way to consent to the missing permissions, in case this user
  is allowed to grant them (**Owner**). Not shown for the Azure CLI client, since it can't take new permissions (**Owner**).

## 3. Non-goals

- Changing the default. Azure CLI stays the default client (**My call**: it covers Resource Graph on its own and most tenants
  already consented to it).
- Requesting specific scopes on ordinary sign-in. Sign-in keeps asking for `.default`; specific scopes are asked only by the
  consent action in section 6 (**My call**: `.default` already returns everything the tenant has consented, and a user who can't
  consent gains nothing from asking for more up front).
- An "ask an admin" flow (copyable consent link, request tracking). The owner asked for a consent action "just in case the user
  has permission"; a user who doesn't sees Microsoft's own screen, which offers the tenant's admin consent request if the tenant
  has turned it on.
- Offering **Create Entra ID application** for Graph CLT sign-ins. It stays Azure CLI only (spec 6.1 of the create-app design).
- Consent for Azure Resource Graph through Graph CLT. Azure queries never use the Graph CLT client.
- Sovereign clouds.

## 4. Anti-goals

- **Never offer the consent action for the Azure CLI client.** It always fails there, and a button that always fails is worse
  than none.
- **Never ask for a write permission** through the consent action. Only permissions whose name contains `.Read` and not `Write`
  are requested, the same rule `GraphRunner.IsReadOnly` and the create-app dialog use. A table that only a write permission
  unlocks shows the error with no consent action.
- Nothing is consented without a click on a button that says so.
- The Azure CLI token used behind a Graph CLT sign-in is never for another user: it is the same home account, or nothing.
- No token is logged, as today.

## 5. Sign-in with Graph CLT

### 5.1 The client

`ClientConfig` gains a second well-known client next to `AzureCli`:

- `GraphCliClientId = "14d82eec-204b-4c2f-b7e8-296a70dab67e"`, tenant `organizations`, and `IsGraphCli`.
- A small helper, `ClientKind` (`AzureCli`, `GraphCli`, `Own`), derived from the client ID, so the rest of the code (and the
  wire, as `clientKind` on `AccountInfo`) asks one question instead of comparing IDs. **My call.**

`account.signIn` already takes any client ID; the UI sends Graph CLT's. Graph CLT's registered redirect URIs include
`http://localhost`, which MSAL's system-browser flow uses, and device code works for it. The builder should confirm both against a
real tenant before relying on them (it is in `docs/manual-checks.md` afterwards, see section 9).

### 5.2 The sign-in screen

`sign-in.tsx`'s "Signing in as" radio group gets a second fixed choice, between the two that exist:

> **Microsoft Graph Command Line Tools**
> Microsoft's public client 14d82eec-204b-4c2f-b7e8-296a70dab67e, used by Graph PowerShell. Reaches what your tenant has
> granted Graph PowerShell. Azure queries use your Azure CLI sign-in.

The account list's label (`clientLabel` in `sign-in.tsx`) shows "Graph Command Line Tools client" for it. Saving it as the
default client works as for the user's own app, through settings.

### 5.3 What this sign-in can read

The card shows the Graph CLT token's scopes, as it does for any client. For a Graph CLT account it adds one static line: "Azure
queries use your Azure CLI sign-in." No probe of the Azure token and no new `AccountInfo` field; Azure access shows itself on the
first Resource Graph run (section 7). **My call.**

## 6. "No permission": the consent action

### 6.1 When it shows

On a run whose outcome is `noPermission`, when all of these hold:

- the active account's client is Graph CLT or the user's own app (never Azure CLI);
- the result names the permissions it is missing, and at least one is a read permission (section 4);
- **none of the listed permissions is already in the account's `Scopes`**. A `noPermission` doesn't always mean missing consent:
  delegated reports also need an Entra role (Reports Reader for `Reports.Read.All`), and hunting's 401/403 also covers a missing
  Defender role. When the token already holds one of the permissions, there is no consent action; the result adds the note
  "You have *permission*; your account may be missing a role that this data needs." **My call.**
- the source is Graph or advanced hunting (both are Graph permissions). Not Resource Graph: with Graph CLT it uses Azure CLI;
  with the user's own app, Azure access already has its own **Grant Azure access** (`consentNeeded`).

Relationship columns refused for permission (the `No permission to read …` chips) get the same action, with that column's
permissions. **My call**: same gap, same answer.

### 6.2 What the result has to carry

Today the Graph `noPermission` result names its permissions only inside the message text (`GraphRunner.NoPermissionMessage`),
and hunting's message is a fixed string. `RunResult` gains `Permissions` (`IReadOnlyList<string>`, read-only ones first, as
`ReadFirst` orders them): the table's permissions for Graph, `ThreatHunting.Read.All` for hunting. The message stays as it is.

### 6.3 What it asks for

The button reads **Grant permission…** (**My call**), and its tooltip names the permission. It asks for **one** permission: the
first read permission in `Permissions` (none of which the account holds, per 6.1), which is the least-privileged read permission Microsoft lists for that path (**My call**:
any one of them will do, and asking for the narrowest is the least an admin has to agree to).

Clicking it calls a new bridge request, `account.consent {key, audience: "graph", scope: "Reports.Read.All"}`.
`AccountService.ConsentAsync` grows a scope parameter: for Graph it runs an interactive acquire on the account's own client for
`https://graph.microsoft.com/<scope>` with the account's username as the login hint and `prompt=consent`, falling back to device
code when no browser opens, as the ARM consent does. The account-mismatch check that exists today applies unchanged.

Then Microsoft decides:

- **The user can grant it** (an admin with a role that can consent for the tenant): Microsoft's screen offers consent, including
  "Consent on behalf of your organization". Kustodian then refreshes the account's Graph token (section 6.4) and runs the query
  again.
- **The user can't**: Microsoft's screen says admin approval is needed, and offers the tenant's request form if the tenant has
  one. MSAL returns an error or the user closes the browser. Kustodian goes back to the result as it was, with a short note
  under it: "Not granted. An administrator has to grant Reports.Read.All." No new dialog. Any other failure (another account
  picked in the browser, a refused request, the network) shows the host's message there instead.

### 6.4 Picking up the new permission

After consent, the cached `.default` access token still has the old `scp` until it expires. `ConsentAsync` for Graph ends by
acquiring a `.default` token with force refresh, so `GetTokenAsync` and the stored `Scopes` (and with them **What this sign-in can
read**, Explain and the account's cached probes) see the new permission at once. Graph objects, probes, licenses and the
advanced hunting schema cached for the account are dropped once consent is granted, even if that refresh fails, as a new sign-in
drops licenses today. The UI then reads the accounts again before it runs the query again, so a run still refused shows the role
note, and reads a built-in or stale advanced hunting schema again. **My call.**

## 7. Azure queries behind a Graph CLT sign-in

Graph CLT is used for Graph only (**Owner**). For `Audience.Arm`, `AccountService.GetTokenAsync` on a Graph CLT account uses
the Azure CLI client instead, for the **same home account ID** (`oid.tid`, the same for both clients):

1. Silent acquire on the Azure CLI client for that home account and the ARM scope. If it works, that's the token. This is the
   quiet case: the user has signed in with Azure CLI before, or did step 2 once.
2. If MSAL has no Azure CLI account for it, or answers ui-required, the run answers `consentNeeded` (audience `arm`), as it does
   today when ARM needs consent. The existing **Grant Azure access** button calls `ConsentAsync(key, Arm)`, which for a Graph
   CLT account runs the interactive acquire on the **Azure CLI** client with the user's username as login hint. The browser
   usually completes it from the existing session. The mismatch check applies: a different account picked in the browser is
   removed and refused.

The Azure CLI sign-in obtained this way is not added to the account list (**My call**: the user signed in once, with Graph CLT,
and sees one account). It lives only in MSAL's cache under the Azure CLI client. Signing out the Graph CLT account removes it
from that cache too, unless the account list has an Azure CLI account for the same user, which keeps it. The other direction
matches: signing out a listed Azure CLI account leaves its MSAL cache entry when a listed Graph CLT account for the same user
still relies on it, and removes it from the account list only. **My call.**

The Azure CLI client behind a Graph CLT account uses the Graph CLT account's stored tenant, not `organizations`. A Graph CLT
account signed in to another tenant (a guest) then gets an ARM token for that tenant, never the user's home tenant. **My call.**

Expiry follows ruling 7 as it is: an ARM failure never marks the Graph CLT account expired.

Resource Graph's tenant and subscription lists (`ArmDirectory`) are keyed by account key, so they need no change: the key is the
Graph CLT account's.

## 8. The Azure CLI client is unchanged

Nothing in this design changes what an Azure CLI sign-in does. "No permission" with the Azure CLI client looks exactly as it
does today, including **Create Entra ID application…** where that already shows.

## 9. Docs

- `docs/EntraPermissions.md`: a section for Graph CLT between "The default" and "Your own app registration": what it is, that it
  reaches what the tenant granted Graph PowerShell, that consent granted to it applies to everyone in the tenant who uses that
  client (Graph PowerShell included), that Azure queries use an Azure CLI sign-in, and the **Grant permission…** action.
- `docs/install.md`: the sign-in paragraph names the three choices.
- `docs/manual-checks.md`: rows for signing in with Graph CLT (browser and device code), a Resource Graph query behind it, and
  **Grant permission…** as an admin and as a non-admin.
- `CHANGELOG.md`, Unreleased.

## 10. Tests

- `AccountService`: Graph CLT account → ARM token comes from the Azure CLI client for the same home account; missing → 
  `ConsentRequiredException("arm")`; `ConsentAsync(Arm)` on a Graph CLT account uses the Azure CLI client with the account's
  stored tenant; sign-out in both directions keeps the Azure CLI cache entry while the other account for that user is listed;
  Graph consent forces a refresh and updates stored scopes.
- `GraphRunner` and hunting: `noPermission` results carry `Permissions`.
- Bridge: `account.consent` with audience `graph` and a scope; refuses write scopes and the Azure CLI client.
- Web: the sign-in radio group's three choices; **Grant permission…** shows for Graph CLT and own app, not for Azure CLI, not
  for Resource Graph, not when only write permissions are listed, not when the account already holds a listed permission (the
  role note shows instead); "Not granted" note after a refusal or cancel.

## 11. Left to the builder

- Exact wording of the tooltip and the "Not granted" note, within the tone of `run-status.tsx`.
- Where `ClientKind` lives in the web code (`wire.ts` next to `AZURE_CLI_CLIENT_ID` is the obvious place).
- How MSAL reports "admin approval needed" (error code or user cancel): both go to the "Not granted" note.
