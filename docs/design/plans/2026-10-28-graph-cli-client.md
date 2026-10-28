# Microsoft Graph Command Line Tools client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sign in with Microsoft Graph Command Line Tools as a third built-in client, route its Azure queries through an Azure CLI
token for the same user, and offer **Grant permission…** on "No permission" results for clients that can take new permissions.

**Architecture:** `ClientConfig` learns a second well-known client and a `ClientKind`. `AccountService` picks the MSAL client per
audience (Graph CLT → Azure CLI for ARM) and grows a Graph consent for one scope. `RunResult` carries the permissions a refused run
needs; the web shows the new sign-in choice and the consent button.

**Tech Stack:** .NET 10 / C# (xUnit), MSAL.NET, React + TypeScript (vitest, Testing Library), oxlint.

**Spec:** `docs/design/specs/2026-10-28-graph-cli-client-design.md`. Section numbers below (§n) refer to it.

## Global Constraints

- Graph CLT client ID `14d82eec-204b-4c2f-b7e8-296a70dab67e`, tenant `organizations`. Azure CLI stays the default.
- Ordinary sign-in keeps asking for `https://graph.microsoft.com/.default`.
- Consent is never offered or performed for the Azure CLI client, and never for a permission that isn't read-only (name contains
  `.Read`, not `Write`; the rule in `GraphRunner.IsReadOnly`).
- Permission names compare case-insensitively.
- Warnings are fixed, never suppressed: `dotnet build -warnaserror`, `npm run lint`, `npm run typecheck` must pass (CLAUDE.md).
- No token, authorization header or consent URL is logged.
- Commit messages end with `Co-Authored-By: Claude <noreply@anthropic.com>`.

## Review Focus

1. A saved default client of Graph CLT: the sign-in screen must start on the Graph CLT choice, not "My own app registration" with
   the ID filled in. Test in Task 6.
2. The user picks a different account in the browser during Graph consent: refused and the stray account removed, as ARM consent
   does. Test in Task 4.
3. A token whose `scp` holds the permission in other casing (`reports.read.all`): no button, role note instead. Test in Task 7.
4. A Graph CLT account in a guest tenant: the ARM token comes from the Azure CLI client built with that tenant ID, never
   `organizations`. Test in Task 3.
5. A refused table that lists no permissions, or only write ones: no button, the message as today. Test in Task 7.

---

### Task 1: The Graph CLT client and `ClientKind`

**Files:**
- Modify: `src/Kustodian/Auth/ClientConfig.cs`
- Modify: `src/Kustodian/Auth/AccountService.cs` (`AccountInfo` record)
- Test: `tests/Kustodian.Tests/Auth/AuthTests.cs`

**Interfaces:**
- Produces: `enum ClientKind { AzureCli, GraphCli, Own }`; `ClientConfig.GraphCliClientId` (const), `ClientConfig.GraphCli`
  (static, tenant `organizations`), `ClientConfig.KindOf(string clientId) : ClientKind` (case-insensitive),
  `ClientConfig.Kind`, `ClientConfig.IsGraphCli`; `AccountInfo.ClientKind` (computed property, serialized camelCase as
  `"azureCli" | "graphCli" | "own"` through the bridge's existing `JsonStringEnumConverter`).

- [ ] **Step 1: Write the failing tests**

```csharp
[Fact]
public void GraphCli_config_has_its_client_id_and_organizations()
{
    Assert.Equal("14d82eec-204b-4c2f-b7e8-296a70dab67e", ClientConfig.GraphCli.ClientId);
    Assert.Equal("organizations", ClientConfig.GraphCli.Tenant);
    Assert.True(ClientConfig.GraphCli.IsGraphCli);
}

[Theory]
[InlineData("04b07795-8ddb-461a-bbee-02f9e1bf7b46", ClientKind.AzureCli)]
[InlineData("14D82EEC-204B-4C2F-B7E8-296A70DAB67E", ClientKind.GraphCli)]
[InlineData("11111111-2222-3333-4444-555555555555", ClientKind.Own)]
public void KindOf_names_the_client(string clientId, ClientKind kind) => Assert.Equal(kind, ClientConfig.KindOf(clientId));

[Fact]
public void AccountInfo_serializes_its_client_kind()
{
    var info = new AccountInfo("k", "ada@contoso.com", "contoso", "t", ClientConfig.GraphCliClientId, true, false, []);
    var json = JsonSerializer.Serialize(info, BridgeJson.Options); // the options the bridge writes with
    Assert.Contains("\"clientKind\":\"graphCli\"", json);
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `dotnet test tests/Kustodian.Tests --filter "FullyQualifiedName~AuthTests"`
Expected: build error, `ClientKind` / `GraphCli` not defined.

- [ ] **Step 3: Implement** the members listed under Interfaces. Use whatever name the bridge's serializer options have in
  `BridgeMessages.cs` in the test above.

- [ ] **Step 4: Run the tests to verify they pass** (same command). Expected: PASS.

- [ ] **Step 5: Commit** `feat(auth): Graph Command Line Tools client and ClientKind`

---

### Task 2: MSAL: force consent and force refresh

**Files:**
- Modify: `src/Kustodian/Auth/MsalClient.cs`
- Modify: every `IMsalClient` fake (`FakeMsal` in `tests/Kustodian.Tests/Auth/AuthTests.cs`, `ArmMsal` in `ArmAuthTests.cs`;
  find the rest with `grep -rn ": IMsalClient" tests`)

**Interfaces:**
- Produces on `IMsalClient`:
  - `Task<MsalSignIn> AcquireInteractiveAsync(string scope, string? loginHint, CancellationToken ct, bool forceConsent = false)`:
    `forceConsent` adds `.WithPrompt(Prompt.Consent)`.
  - `Task<MsalToken> AcquireSilentAsync(string homeAccountId, string scope, CancellationToken ct, bool forceRefresh = false)`:
    `forceRefresh` adds `.WithForceRefresh(true)`.
- Fakes record both flags: `Interactive` entries become `(string Scope, string? LoginHint, bool ForceConsent)` where they are
  asserted; add `List<(string Scope, bool ForceRefresh)> Silent` to the fakes Task 4 uses.

No new behaviour to test here: the real client is checked by hand (`MsalClient` summary). Existing tests must still pass.

- [ ] **Step 1: Change the interface, `MsalClient` and the fakes.**
- [ ] **Step 2: Run** `dotnet build -warnaserror && dotnet test tests/Kustodian.Tests`. Expected: build clean, all PASS.
- [ ] **Step 3: Commit** `refactor(auth): let MSAL calls force consent and refresh`

---

### Task 3: Azure tokens behind a Graph CLT sign-in (§7)

**Files:**
- Modify: `src/Kustodian/Auth/AccountService.cs` (`GetTokenAsync`, `ConsentAsync`, `SignOutAsync`)
- Test: `tests/Kustodian.Tests/Auth/ArmAuthTests.cs` (needs a client factory that hands out one fake per `ClientConfig` and
  records the configs it was asked for: `Func<ClientConfig, IMsalClient>`)

**Interfaces:**
- Consumes: `ClientConfig.Kind`, `ClientConfig.AzureCliClientId` (Task 1).
- Produces: `private ClientConfig ClientFor(StoredAccount stored, Audience audience)`: for a Graph CLT account and `Audience.Arm`,
  `new ClientConfig(AzureCliClientId, stored.Tenant)`; otherwise the account's own config. `GetTokenAsync` and
  `ConsentAsync(…, Audience.Arm, …)` use it; behaviour for other clients is unchanged.

- [ ] **Step 1: Write the failing tests**

```csharp
[Fact] public async Task Graph_cli_account_gets_its_arm_token_from_the_azure_cli_client_for_the_same_home_account()
// sign in with ClientConfig.GraphCli; Azure CLI fake has the same HomeAccountId cached;
// GetTokenAsync(key, Audience.Arm) returns the Azure CLI fake's token; the Graph CLT fake saw no ARM-scope silent call.

[Fact] public async Task Graph_cli_account_without_an_azure_cli_sign_in_needs_azure_consent_and_stays_valid()
// Azure CLI fake has no account → ConsentRequiredException with Audience "arm"; ListAccountsAsync shows the account not expired.

[Fact] public async Task Azure_consent_for_a_graph_cli_account_signs_in_the_azure_cli_client_with_a_login_hint()
// ConsentAsync(key, Audience.Arm) → Azure CLI fake's Interactive == [("https://management.azure.com/.default", "ada@contoso.com", false)].

[Fact] public async Task Graph_cli_account_in_a_guest_tenant_asks_azure_cli_for_that_tenant()
// stored tenant "guest-tenant-id" → the factory was asked for new ClientConfig(AzureCliClientId, "guest-tenant-id"),
// never for "organizations".

[Fact] public async Task Graph_cli_account_still_uses_its_own_client_for_graph()

[Fact] public async Task Own_app_account_uses_its_own_client_for_arm()

[Fact] public async Task Signing_out_graph_cli_removes_its_azure_cli_entry_unless_an_azure_cli_account_for_that_user_is_listed()

[Fact] public async Task Signing_out_azure_cli_keeps_its_cache_entry_while_a_graph_cli_account_for_that_user_is_listed()
// the Azure CLI account leaves the list; the Azure CLI fake's RemoveAsync was not called; the Graph CLT account's ARM token works.
```

- [ ] **Step 2: Run** `dotnet test tests/Kustodian.Tests --filter "FullyQualifiedName~ArmAuthTests"`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** `ClientFor(StoredAccount, Audience)` and use it in `GetTokenAsync` and `ConsentAsync`. In
  `SignOutAsync`, remove an MSAL entry only when no other listed account with the same `HomeAccountId` relies on that client
  (a Graph CLT account relies on the Azure CLI client of its own tenant). The account-mismatch check in `ConsentAsync` runs on the
  client actually used.
- [ ] **Step 4: Run** the same command. Expected: PASS, and the existing ARM tests still PASS.
- [ ] **Step 5: Commit** `feat(auth): Azure queries behind a Graph CLT sign-in use the Azure CLI client`

---

### Task 4: Graph consent for one permission (§6.3, §6.4)

**Files:**
- Modify: `src/Kustodian/Auth/AccountService.cs` (`ConsentAsync`)
- Modify: `src/Kustodian/Bridge/Handlers/AccountHandler.cs` (`account.consent`, `ConsentParams`, summary)
- Test: `tests/Kustodian.Tests/Auth/ArmAuthTests.cs` (service), `tests/Kustodian.Tests/Bridge/AccountHandlerTests.cs` (bridge);
  update `Account_consent_over_the_bridge_answers_empty_object`, whose `audience = "graph"` without a scope must stay `bad_request`.

**Interfaces:**
- Consumes: `forceConsent`, `forceRefresh` (Task 2); `ClientConfig.Kind` (Task 1).
- Produces:
  - `AccountService.ConsentAsync(string accountKey, Audience audience, CancellationToken ct, Action<string>? showCode = null, string? scope = null)`.
    For `Audience.Graph`, `scope` is required (a permission name such as `Reports.Read.All`); it acquires interactively
    `https://graph.microsoft.com/<scope>` with the username as login hint and `forceConsent: true` (device-code fallback as for ARM),
    then `AcquireSilentAsync(home, ".default" Graph scope, ct, forceRefresh: true)` and stores the new `Scopes`. Throws
    `InvalidOperationException` for an Azure CLI account.
  - Bridge: `account.consent {key, audience: "graph", scope: "Reports.Read.All"}` answers `{}` (a single `scope`, not the
    spec's `scopes` array: §6.3 asks for exactly one permission); on success it drops the account's
    Graph objects, probes and licenses (`objects.RemoveAccountAsync`, `probes.RemoveAccountAsync`, `licenses?.RemoveAccount`).
    `bad_request` when: no scope, a scope that isn't read-only, or an Azure CLI account. Cancel → `cancelled`, as for ARM.

- [ ] **Step 1: Write the failing tests**

```csharp
[Fact] public async Task Graph_consent_asks_for_the_one_permission_with_prompt_consent_and_a_login_hint()
// Interactive[^1] == ("https://graph.microsoft.com/Reports.Read.All", "ada@contoso.com", true)

[Fact] public async Task Graph_consent_refreshes_the_default_token_and_stores_the_new_scopes()
// Silent[^1] == ("https://graph.microsoft.com/.default", true); ListAccountsAsync()[0].Scopes contains "Reports.Read.All"

[Fact] public async Task Graph_consent_as_another_account_is_refused_and_the_stray_account_removed()

[Fact] public async Task Graph_consent_is_refused_for_the_azure_cli_client()

[Fact] public async Task Account_consent_for_graph_needs_a_read_only_scope_and_drops_the_accounts_caches()
// over the bridge: no scope → bad_request; "User.ReadWrite.All" → bad_request; Azure CLI account → bad_request;
// "Reports.Read.All" on a Graph CLT account → {} and the object cache no longer has the account's entries.
```

- [ ] **Step 2: Run** `dotnet test tests/Kustodian.Tests --filter "FullyQualifiedName~ArmAuthTests|FullyQualifiedName~AccountHandlerTests"`.
  Expected: new tests FAIL.
- [ ] **Step 3: Implement** as under Interfaces. Put the read-only check in one place both the bridge and `GraphRunner` can reach
  (move `IsReadOnly` to `GraphPermissions` in `Kustodian.Graph` as `public static bool IsReadOnly(string permission)`).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(auth): consent to one Graph permission from Kustodian`

---

### Task 5: Refused runs name their permissions (§6.2)

**Files:**
- Modify: `src/Kustodian.Graph/Run/RunResult.cs`, `src/Kustodian.Graph/Run/GraphRunner.cs`
- Modify: `src/Kustodian.Sources/Hunting/HuntingQuerySource.cs`, `src/Kustodian.Sources/Hunting/HuntingClient.cs`
- Modify: `src/Kustodian/Bridge/BridgeMessages.cs` (`RunResultWire`)
- Test: `tests/Kustodian.Graph.Tests/Run/GraphRunnerTests.cs`, `tests/Kustodian.Sources.Tests/Hunting/HuntingQuerySourceTests.cs`,
  the bridge test that checks `query.run`'s JSON (find with `grep -rn durationMs tests`)

**Interfaces:**
- Produces: `RunResult.Permissions` (`IReadOnlyList<string>`, init-only, default `[]`), on the wire as `permissions: string[]`.
  Graph `NoPermission`: the refused table's permissions, read-only first (`ReadFirst`). Hunting `NoPermission`:
  `["ThreatHunting.Read.All"]` (`HuntingClient.Permission` const). Every other outcome: `[]`.

- [ ] **Step 1: Write the failing tests**

```csharp
[Fact] public async Task No_permission_names_the_tables_permissions_read_only_first()
// a fake table with Permissions ["AuditLog.ReadWrite.All", "Reports.Read.All"] refused 403 →
// result.Permissions == ["Reports.Read.All", "AuditLog.ReadWrite.All"]; Message unchanged.

[Fact] public async Task Hunting_no_permission_names_threat_hunting_read_all()

[Fact] public void Run_result_wire_has_permissions()
// serialized JSON has "permissions":["Reports.Read.All"]
```

- [ ] **Step 2: Run** `dotnet test` on the three test projects. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** `ReadFailure` returns the permissions with the outcome; `End` takes them. The message text stays.
- [ ] **Step 4: Run** `dotnet build -warnaserror && dotnet test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(run): refused runs name the permissions they need`

---

### Task 6: Sign-in screen (§5.2, §5.3)

**Files:**
- Modify: `web/src/wire.ts`, `web/src/signin/sign-in.tsx`
- Test: `web/src/signin/sign-in.test.tsx`

**Interfaces:**
- Produces in `wire.ts`: `GRAPH_CLI_CLIENT_ID = '14d82eec-204b-4c2f-b7e8-296a70dab67e'`;
  `type ClientKind = 'azureCli' | 'graphCli' | 'own'`; `AccountInfo.clientKind: ClientKind`; `RunResult.permissions: string[]`.
- `sign-in.tsx`: the boolean `own`/`setOwn` becomes `choice: ClientKind`. Graph CLT sends
  `{ clientId: GRAPH_CLI_CLIENT_ID, tenant: <typed tenant or null> }`. A saved default client equal to `GRAPH_CLI_CLIENT_ID`
  (any case) starts on `graphCli`, not `own`. `clientLabel` returns `'Graph Command Line Tools client'` for it. Re-signing an
  account from the list sends its `clientId` for Graph CLT as it does for an own app.

Exact copy for the choice (§5.2):

```
Microsoft Graph Command Line Tools
Microsoft's public client 14d82eec-204b-4c2f-b7e8-296a70dab67e, used by Graph PowerShell. Reaches what your tenant has granted Graph PowerShell. Azure queries use your Azure CLI sign-in.
```

In **What this sign-in can read**, for an active Graph CLT account, the line `Azure queries use your Azure CLI sign-in.`

- [ ] **Step 1: Write the failing tests**

```tsx
it('offers three clients and signs in with graph cli', …)
// radios named /Azure CLI/, /Microsoft Graph Command Line Tools/, /My own app registration/;
// choosing Graph CLT and signing in calls account.signIn with clientId GRAPH_CLI_CLIENT_ID.
it('a saved graph cli default starts on graph cli, not own app', …)
// defaults { clientId: '14D82EEC-…', tenant: null } → Graph CLT radio checked, client ID field disabled.
it('labels a graph cli account and says azure queries use azure cli', …)
```

- [ ] **Step 2: Run** `cd web && npx vitest run src/signin/sign-in.test.tsx`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd web && npm test && npm run lint && npm run typecheck`. Expected: PASS, no warnings beyond the two
  known ones in CLAUDE.md.
- [ ] **Step 5: Commit** `feat(web): sign in with Microsoft Graph Command Line Tools`

---

### Task 7: **Grant permission…** on refused runs (§6.1, §6.3)

**Files:**
- Create: `web/src/signin/grant-permission.ts` (the rule), `web/src/signin/grant-permission-button.tsx`
- Modify: `web/src/results/run-status.tsx`, `web/src/app.tsx` (pass the active account)
- Test: `web/src/signin/grant-permission.test.ts`, `web/src/results/run-status.test.tsx`

**Interfaces:**
- Consumes: `AccountInfo.clientKind`, `RunResult.permissions` (Task 6); bridge `account.consent` with `scope` (Task 4).
- Produces:
  - `grantOffer(account: AccountInfo | undefined, permissions: string[], source: string): { scope: string } | { held: string } | null`.
    `null` when: no account, Azure CLI, source `arg`, or no read-only permission. `{ held }` when the account's `scopes` already
    hold any listed permission (case-insensitive): the first one held. Otherwise `{ scope }`: the first read-only permission.
    `isReadOnly` here mirrors the host rule.
  - `GrantPermissionButton({ accountKey, scope, onGranted })`: button **Grant permission…**, `title` = the scope. Calls
    `account.consent { key, audience: 'graph', scope }`; success → `onGranted()`; `cancelled` or any refusal → note
    `Not granted. An administrator has to grant <scope>.` (text-bad, role alert, as `ConsentButton` shows problems).
  - `RunStatus` takes `account?: AccountInfo` (replacing nothing; `accountKey` stays). On `noPermission`: `{ scope }` → the button;
    `{ held }` → a chip `You have <held>; your account may be missing a role that this data needs.` Relationship chips refused for
    permission get the same button for that column's `permissions` (one button per distinct scope).
  - `app.tsx` passes `account={account}`; `onGranted` reruns the tab, as `onConsented` does.

- [ ] **Step 1: Write the failing tests**

```ts
// grant-permission.test.ts
it('offers the first read permission to a graph cli account', () =>
  expect(grantOffer(graphCli([]), ['Reports.Read.All', 'AuditLog.Read.All'], 'graph')).toEqual({ scope: 'Reports.Read.All' }));
it('offers nothing to azure cli', () => expect(grantOffer(azureCli([]), ['Reports.Read.All'], 'graph')).toBeNull());
it('offers nothing for resource graph', () => expect(grantOffer(own([]), ['x.Read.All'], 'arg')).toBeNull());
it('offers nothing for write-only or empty lists', () => {
  expect(grantOffer(graphCli([]), ['User.ReadWrite.All'], 'graph')).toBeNull();
  expect(grantOffer(graphCli([]), [], 'graph')).toBeNull();
});
it('says the permission is held, in any casing', () =>
  expect(grantOffer(graphCli(['reports.read.all']), ['Reports.Read.All'], 'graph')).toEqual({ held: 'Reports.Read.All' }));
it('offers threat hunting for hunting', () =>
  expect(grantOffer(own([]), ['ThreatHunting.Read.All'], 'hunting')).toEqual({ scope: 'ThreatHunting.Read.All' }));
```

```tsx
// run-status.test.tsx
it('no_permission_for_graph_cli_shows_grant_permission_and_reruns_after_consent', …)
it('grant_permission_refused_shows_not_granted_note', …)   // call rejects with BridgeError 'cancelled'
it('no_permission_for_azure_cli_shows_no_grant_permission', …)
it('no_permission_with_the_permission_held_shows_the_role_note', …)
it('refused_relationship_column_offers_grant_permission', …)
```

- [ ] **Step 2: Run** `cd web && npx vitest run src/signin/grant-permission.test.ts src/results/run-status.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd web && npm test && npm run lint && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): grant a missing permission from a refused run`

---

### Task 8: Docs (§9)

**Files:**
- Modify: `docs/EntraPermissions.md`, `docs/install.md`, `docs/manual-checks.md`, `CHANGELOG.md` (Unreleased)

- [ ] **Step 1:** `EntraPermissions.md`: a section "Microsoft Graph Command Line Tools" between "The default: the Azure CLI
  client" and "Your own app registration", covering the five points in §9 (what it is; reaches what the tenant granted Graph
  PowerShell; consent applies tenant-wide to everyone using that client; Azure queries use an Azure CLI sign-in; **Grant
  permission…** and the role note). `install.md`: the sign-in paragraph names the three choices.
- [ ] **Step 2:** `manual-checks.md`: rows in the existing table format for: sign in with Graph CLT (browser); sign in with Graph
  CLT (device code); Resource Graph query behind a Graph CLT sign-in, first time and after; **Grant permission…** as an admin;
  **Grant permission…** as a non-admin.
- [ ] **Step 3:** `CHANGELOG.md` Unreleased: one "Added" entry for the client and one for **Grant permission…**.
- [ ] **Step 4: Run** the full check: `dotnet build -warnaserror && dotnet test && cd web && npm test && npm run lint && npm run typecheck`.
  Expected: all PASS.
- [ ] **Step 5: Commit** `docs: Microsoft Graph Command Line Tools client`
