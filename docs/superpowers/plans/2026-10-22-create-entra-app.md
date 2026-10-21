# Create Entra ID Application Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a signed-in Azure CLI user can create a Kustodian app registration through Graph from a dialog. The dialog lists the
least set of read permissions, derived from data. It then offers admin consent and switching to the new app.

**Architecture:**

- **Permission data.** The schema tool writes a second bundled file, `graph-permissions.json`: every delegated permission that
  can read each table.
- **Planner.** A pure planner in the host turns that file, the data areas and the two source permissions into the grouped,
  default-ticked list.
- **Client.** `EntraAppClient` makes the Graph calls over the existing Graph HTTP client.
- **Bridge.** A new `EntraAppHandler` exposes `entraApp.*`.
- **Web.** The web adds a dialog on the sign-in screen, a palette command, and a button on `noPermission` runs.

**Tech Stack:** .NET 10, xUnit v3, `Microsoft.Extensions.Time.Testing`, React + TypeScript, Vitest, oxlint. No new
dependencies.

**Spec:** `kustodian/docs/superpowers/specs/2026-10-22-create-entra-app-design.md`. Mockups: `kustodian/docs/mockups/EntraApp.dc.html`,
`EntraAppCreated.dc.html` and `EntraAppRefused.dc.html`.

## Global Constraints

- **Repository rules.**
  - Everything stays under `kustodian/`.
  - No warning suppressions: `dotnet build -warnaserror`, `oxlint` and `tsc` must pass. See `CLAUDE.md` and
    `kustodian/CLAUDE.md`.
  - Run each git command on its own.
- **Logging and storage.**
  - Tokens, `Authorization` headers and the consent URL's `state` are never logged or written to the run log.
  - No browser storage.
  - Every action is a command.
  - Menus and disclosures close on click-outside or Esc.
- **Write permissions are never offered.** A permission is offered only when its name contains `.Read` and does not contain
  `Write`.
- **Default ticks:** these areas are ticked:
  - Users, groups and directory;
  - Apps and permissions;
  - Sign-in and audit logs;
  - Risk and identity protection;
  - Access reviews and privileged roles;
  - Policies and Conditional Access;
  - Devices and Intune;
  - Security;
  - advanced hunting;
  - Azure Resources.

  Mail, Teams and files; Reports and usage; and Other are unticked. A permission takes the tick of its home area.
- **Top-level groups:** Graph (subgroups = `GraphAreas.Names` minus Security), Security (Advanced hunting, Graph security
  data), Azure Resources (Resource Graph).
- **Enable rule:** Azure CLI client, not expired, and `scp` contains `Application.ReadWrite.All` or `Directory.AccessAsUser.All`.
- **Fixed IDs and URIs.**

  | What | Value |
  |---|---|
  | Microsoft Graph app ID | `00000003-0000-0000-c000-000000000000` |
  | Azure Service Management app ID | `797f4846-ba00-4fd7-ba43-dac1f8f63013` |
  | Redirect URIs | `http://localhost` and `https://login.microsoftonline.com/common/oauth2/nativeclient` |
  | `signInAudience` | `AzureADMyOrg` |
  | `isFallbackPublicClient` | `true` |

- **Admin consent URL:** exactly
  `https://login.microsoftonline.com/{tenantId}/v2.0/adminconsent?client_id={appId}&scope=https://graph.microsoft.com/.default&redirect_uri=https://login.microsoftonline.com/common/oauth2/nativeclient`,
  plus `&state={random}` only when Kustodian opens it itself. The query values are URL-encoded.
- **Roles that can grant** (template IDs):

  | Role | Template ID |
  |---|---|
  | Global Administrator | `62e90394-69f5-4237-9190-012177145e10` |
  | Privileged Role Administrator | `e8611ab8-c189-46e8-94e1-60213ab1f814` |
  | Cloud Application Administrator | `158c047a-c907-4556-b7ef-446551a6b5f7` |
  | Application Administrator | `9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3` |
  | AI Administrator | `d2562ede-74db-457e-a7b6-544e236ebb61` |

  These were checked against Microsoft Learn's built-in roles page on 2026-10-22.
- **The builder never calls Graph with a real account,** creates an app or grants consent. Tests use fakes. Running
  `tools/schema` downloads public files only and is allowed.

## Review Focus

1. **The Graph tenant isn't the home tenant** (a guest or pinned sign-in). The app, consent URL, Entra link and saved
   `signIn.tenant` all use `/organization`'s ID. Test in Task 3 (`Plan_reads_tenant_from_organization`) and Task 4.
2. **Unticking a permission whose tables are all covered by another ticked one** shows no "You lose" line. Unticking the last
   cover shows each lost table once. Test in Task 2 (`Lost_tables_only_counts_tables_with_no_other_ticked_cover`).
3. **Esc or a click outside during Create** must not close the dialog or orphan the request. Test in Task 5
   (`does not close while creating`).
4. **Service principal 403 or retries exhausted** leaves the app. Try again retries step 4 only, and the consent step still
   offers the link. Test in Task 3 (`Service_principal_403_returns_app_without_principal`) and Task 6.
5. **A ticked permission missing from the tenant's Graph** is dropped and named, not a failure. Test in Task 3
   (`Unknown_scope_is_dropped_and_named`).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/Kustodian.Graph/Schema/GraphPermissionCatalog.cs` (new) | Reads `permissions.json` into every read-capable delegated permission and its table paths; JSON read/write; embedded `Bundled`. |
| `src/Kustodian.Graph/Schema/graph-permissions.json` (new, generated) | The catalog for today's schema. |
| `tools/schema/Program.cs` | Writes `graph-permissions.json` too. |
| `src/Kustodian/Auth/EntraApp/PermissionPlanner.cs` (new) | Pure cover, grouping, default ticks, lost tables. |
| `src/Kustodian/Auth/EntraApp/SourcePermissions.cs` (new) | Hunting and ARG requirements. |
| `src/Kustodian/Auth/EntraApp/EntraAppClient.cs` (new) | Graph calls and the consent URL. |
| `src/Kustodian/Auth/EntraApp/SystemBrowser.cs` (new) | Opens one https URL in the OS browser. |
| `src/Kustodian/Bridge/Handlers/EntraAppHandler.cs` (new) | `entraApp.*` commands. |
| `src/Kustodian/App/AppServices.cs` | Registers the handler. |
| `web/src/wire.ts`, `web/src/bridge.mock.ts` | Types and mock answers. |
| `web/src/signin/create-app-dialog.tsx` (new) | Dialog: choose, create, failure, created. |
| `web/src/signin/permission-list.tsx` (new) | Grouped tri-state list with lost tables and totals. |
| `web/src/signin/sign-in.tsx`, `web/src/app.tsx`, `web/src/results/run-status.tsx` | Button, command and noPermission button. |
| `docs/manual-checks.md` | The owner's manual checks. |

---

### Task 1: Permission catalog from `permissions.json`

**Files:**
- Create: `src/Kustodian.Graph/Schema/GraphPermissionCatalog.cs`, `src/Kustodian.Graph/Schema/graph-permissions.json`
- Modify: `src/Kustodian.Graph/Kustodian.Graph.csproj` (embed `Schema/graph-permissions.json`, LogicalName
  `graph-permissions.json`), `tools/schema/Program.cs`, `tools/schema/README.md`
- Modify: `tests/Kustodian.Graph.Tests/Schema/permissions-excerpt.json`. Add `Directory.Read.All` with `/users` and
  `/applications` in a GET-only `DelegatedWork` set with an empty marker, `requiresAdminConsent: true`, and the
  `userDescription` copied from Microsoft's file.
- Test: `tests/Kustodian.Graph.Tests/Schema/GraphPermissionCatalogTests.cs`

**Interfaces:**
- Produces:

  ```csharp
  public sealed record CatalogPermission(string Name, bool AdminConsent, string Description, IReadOnlyList<string> Tables);
  public sealed record GraphPermissionCatalog(string Source, IReadOnlyList<CatalogPermission> Permissions)
  {
      public static GraphPermissionCatalog Bundled { get; }
      public static GraphPermissionCatalog Build(Stream permissionsJson, IEnumerable<GraphTable> tables, string source);
      public static GraphPermissionCatalog Read(Stream json);
      public static string Write(GraphPermissionCatalog catalog);
  }
  ```

  - `Tables` holds table paths exactly as `GraphTable.Path`.
  - `Build` keeps `DelegatedWork` path sets whose methods include `GET`, with any marker. A table matches when
    `GraphPermissions.NormalizePath("/" + table.Path)` equals the normalized path.
  - Permissions with no table are omitted. The rest are sorted by name, with their tables sorted ordinally.
  - The read-only filter is **not** applied here; the planner applies it.

- [ ] **Step 1: Write failing tests**
  - `Build_lists_every_permission_that_can_read_a_table`: over the excerpt with tables `users`, `applications` and
    `auditLogs/signIns`.
    - `Directory.Read.All` has `["applications", "users"]`.
    - `User.ReadBasic.All` contains `users`.
    - `AuditLog.Read.All` contains `auditLogs/signIns`.
  - `Build_takes_admin_consent_and_description_from_DelegatedWork`: `Directory.Read.All` has `AdminConsent == true` and its
    `userDescription`.
  - `Build_ignores_permissions_without_DelegatedWork_or_GET`: inline JSON with an `Application`-only permission and a
    `POST`-only set; neither appears.
  - `Write_then_Read_round_trips`.
  - `Bundled_loads`: `Bundled.Permissions` is non-empty and contains `Directory.Read.All` covering `users`.
- [ ] **Step 2: Run `dotnet test tests/Kustodian.Graph.Tests --filter GraphPermissionCatalogTests`.** Expected: FAIL (type
  missing).
- [ ] **Step 3: Implement `GraphPermissionCatalog`.** JSON is camelCase with 2-space indent, like `graph-beta.json`.
- [ ] **Step 4: Change `tools/schema/Program.cs`.**
  - After building the schema, re-open the permissions input and build the catalog with `generated.Tables`.
  - Write it to `graph-permissions.json` beside the schema path (an `--permissions-out` override is optional).
  - The catalog is written even when the schema diff is empty. The current early `return 0` on "Nothing to write" must not
    skip it.
  - Print `Permissions: N`.
  - Update the README's Inputs/Outputs.
- [ ] **Step 5: Generate the bundled file.** Run `dotnet run --project tools/schema`. It downloads public data; set
  `GITHUB_TOKEN` if rate-limited. If the schema diff is not empty, keep only `graph-permissions.json` and restore
  `graph-beta.json` with `git checkout -- src/Kustodian.Graph/Schema/graph-beta.json`. A schema refresh is out of scope.
- [ ] **Step 6: Run the Graph tests and `dotnet build -warnaserror`.** Expected: PASS.
- [ ] **Step 7: Commit.** Message: `feat(kustodian): bundle every delegated read permission per Graph table`.

### Task 2: Permission planner

**Files:**
- Create: `src/Kustodian/Auth/EntraApp/SourcePermissions.cs`, `src/Kustodian/Auth/EntraApp/PermissionPlanner.cs`
- Test: `tests/Kustodian.Tests/Auth/EntraApp/PermissionPlannerTests.cs`

**Interfaces:**
- Consumes: `GraphPermissionCatalog`, `GraphAreas`, `GraphSchemaCatalog.Beta.Tables`.
- Produces:

  ```csharp
  public sealed record SourcePermission(string ResourceAppId, string ResourceName, string Scope, bool AdminConsent,
      string Unlocks, string GroupId, string SubgroupTitle);
  public static class SourcePermissions
  {
      public const string GraphAppId = "00000003-0000-0000-c000-000000000000";
      public const string ArmAppId = "797f4846-ba00-4fd7-ba43-dac1f8f63013";
      public static SourcePermission Hunting { get; }    // Graph, ThreatHunting.Read.All, admin, "Defender advanced hunting tabs", "security", "Advanced hunting"
      public static SourcePermission ResourceGraph { get; } // ARM, user_impersonation, not admin, "Azure Resource Graph tabs, subscriptions and management groups", "azure", "Resource Graph"
  }
  public sealed record PlannedPermission(string Resource, string ResourceAppId, string Name, bool AdminConsent,
      string Description, IReadOnlyList<string> Tables, string? Unlocks, bool Ticked);
  public sealed record PlannedSubgroup(string Title, IReadOnlyList<PlannedPermission> Permissions);
  public sealed record PlannedGroup(string Id, string Title, IReadOnlyList<PlannedSubgroup> Subgroups); // ids "graph","security","azure"
  public sealed record PermissionPlan(IReadOnlyList<PlannedGroup> Groups, int TablesWithData, int TablesWithoutData, int WriteOnlyTables);
  public static class PermissionPlanner
  {
      public static PermissionPlan Plan(GraphPermissionCatalog catalog, IReadOnlyList<GraphTable> tables, GraphAreas areas);
      public static IReadOnlyList<string> LostTables(PermissionPlan plan, ISet<string> ticked, string untick); // keys "resource|name"
  }
  ```

  - `Resource` is `"Microsoft Graph"` or `"Azure Service Management"`.
  - `ThreatHunting.Read.All` is listed only once, under Security → Advanced hunting, even if the catalog has it.

- [ ] **Step 1: Write failing tests** over a small hand-built catalog, tables and areas, each named for the rule it pins:
  - `Read_only_filter_drops_Write_and_non_Read_names`: `X.ReadWrite.All`, `Directory.AccessAsUser.All` and
    `AppCatalog.Submit` are absent.
  - `Greedy_cover_prefers_the_permission_covering_most_uncovered_tables`: a broad permission is picked and a narrow one fully
    inside it is not.
  - `Ties_prefer_no_admin_consent_then_name`.
  - `Permission_is_homed_in_its_majority_area_ties_to_first_in_Names_order`.
  - `Security_area_moves_to_Security_group_under_Graph_security_data`.
  - `Default_tick_follows_home_area`: a Mail-homed permission that also covers one directory table is unticked.
  - `Sources_are_added`: hunting under security / "Advanced hunting", ticked and admin; ARG under azure / "Resource Graph",
    ticked and not admin.
  - `Counts_tables_without_data_and_write_only_tables`.
  - `Lost_tables_only_counts_tables_with_no_other_ticked_cover` (Review Focus 2).
  - `Bundled_plan_matches_spec_numbers`: over the real bundled data, 67 Graph read permissions, plus 295 covered and 8
    write-only tables. If the regenerated file shifts these, update the assertion and the spec's numbers together.
- [ ] **Step 2: Run `dotnet test tests/Kustodian.Tests --filter PermissionPlannerTests`.** Expected: FAIL.
- [ ] **Step 3: Implement.** Greedy cover per spec 5.2: repeatedly take the permission covering the most uncovered tables,
  then fewer admin, then ordinal name. Group order follows `GraphAreas.Names`; subgroups with no permission are omitted.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** Message: `feat(kustodian): plan the least read permissions for an Entra app`.

### Task 3: Entra app client

**Files:**
- Create: `src/Kustodian/Auth/EntraApp/EntraAppClient.cs`
- Test: `tests/Kustodian.Tests/Auth/EntraApp/EntraAppClientTests.cs`, with a private stub `HttpMessageHandler` that records
  requests and answers from a function (like `AuthTests.RecordingHandler`)

**Interfaces:**
- Consumes: an `HttpClient` from `GraphHttp.CreateClient`. Every request is tagged with `.ForAccount(accountKey)` and uses
  absolute `https://graph.microsoft.com/v1.0/...` URIs, because the client's base address is beta. `PlannedPermission` comes
  from Task 2.
- Produces:

  ```csharp
  public sealed record EntraTenant(string Id, string DisplayName);
  public sealed record CreateRequest(string Name, IReadOnlyList<PlannedPermission> Permissions);
  public enum CreateStep { LookUp, CreateApp, AddOwner, CreateServicePrincipal }
  public sealed record CreateResult(string AppId, string ObjectId, string? ServicePrincipalId, string TenantId,
      bool OwnerAdded, string? OwnerMessage, IReadOnlyList<string> Dropped, string? ServicePrincipalMessage);
  public sealed record ConsentStatus(IReadOnlyList<string> Granted, IReadOnlyList<string> Missing);
  public sealed class EntraAppException(string message, bool nothingCreated) : Exception(message) { public bool NothingCreated { get; } }
  public sealed class EntraAppClient(HttpClient graph, TimeProvider time)
  {
      public Task<EntraTenant> TenantAsync(string accountKey, CancellationToken ct);
      public Task<CreateResult> CreateAsync(string accountKey, EntraTenant tenant, CreateRequest request, Action<CreateStep> onStep, CancellationToken ct);
      public Task<CreateResult> RetryServicePrincipalAsync(string accountKey, CreateResult partial, CancellationToken ct);
      public Task<ConsentStatus> ConsentStatusAsync(string accountKey, string appId, IReadOnlyList<string> adminScopes, CancellationToken ct);
      public Task<bool?> CanGrantAsync(string accountKey, CancellationToken ct);
      public static Uri ConsentUrl(string tenantId, string appId, string? state);
  }
  ```

- [ ] **Step 1: Write failing tests.**
  - `Plan_reads_tenant_from_organization`: `GET /v1.0/organization?$select=id,displayName` returns that ID and name (Review
    Focus 1).
  - `Create_sends_the_application_body`. The `POST /v1.0/applications` JSON has:
    - `displayName`, `signInAudience: "AzureADMyOrg"`, `isFallbackPublicClient: true`;
    - `publicClient.redirectUris` equal to the two URIs;
    - `requiredResourceAccess` with one entry per resource app ID, each `{id, type: "Scope"}`. The IDs come from the stubbed
      `oauth2PermissionScopes` of `GET /v1.0/servicePrincipals(appId='…')?$select=id,oauth2PermissionScopes`.
  - `Create_skips_Azure_lookup_when_user_impersonation_unticked`.
  - `Unknown_scope_is_dropped_and_named` (Review Focus 5).
  - `Owner_is_added_from_me`: `GET /v1.0/me?$select=id`, then `POST /v1.0/applications/{objectId}/owners/$ref` with
    `@odata.id` `https://graph.microsoft.com/v1.0/directoryObjects/{me}`. A 400 whose message contains "already exist" means
    `OwnerAdded == true`. Any other failure means `OwnerAdded == false` with the message, and the create still succeeds.
  - `Service_principal_is_retried_on_404_and_400_with_backoff`. Use `FakeTimeProvider`. The delays are 1, 2, 4, 8 and 8 s, then
    the call gives up with `ServicePrincipalId == null` and a message.
  - `Service_principal_403_returns_app_without_principal` (Review Focus 4): there is no retry, and the message is "You can't
    create its enterprise application; an admin's consent (next step) creates it."
  - `Create_403_means_nothing_created`: on `POST /applications` with `Authorization_RequestDenied`, it throws
    `EntraAppException` with `NothingCreated == true` and the spec 6.4 message.
  - `Lookup_failure_means_nothing_created`: the message starts "Kustodian couldn't read Microsoft Graph's permission list in
    your tenant."
  - `Steps_are_reported_in_order`: LookUp, CreateApp, AddOwner, CreateServicePrincipal.
  - `ConsentStatus_finds_principal_by_appId_and_reads_AllPrincipals_grants`:
    - It reads `GET /v1.0/servicePrincipals(appId='{appId}')?$select=id`, then
      `GET /v1.0/oauth2PermissionGrants?$filter=clientId eq '{spId}' and consentType eq 'AllPrincipals'`.
    - It splits each grant's `scope` on spaces.
    - `Missing` is the admin scopes not granted. A 404 on the service principal means everything is missing.
  - `CanGrant_true_for_listed_roles_false_otherwise_null_on_failure`: from
    `GET /v1.0/me/memberOf/microsoft.graph.directoryRole?$select=roleTemplateId`.
  - `ConsentUrl_is_exact`: with and without state, compared to the Global Constraints string.
  - `Requests_name_the_account`: every request carries the account option (`GraphRequestAccount.Key`).
- [ ] **Step 2: Run `dotnet test tests/Kustodian.Tests --filter EntraAppClientTests`.** Expected: FAIL.
- [ ] **Step 3: Implement.** Use `System.Text.Json` nodes for bodies and `TimeProvider.Delay` for the backoff. Graph errors
  are read from `error.code` and `error.message`. Nothing logs bodies.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** Message: `feat(kustodian): create Entra app registrations through Graph`.

### Task 4: Bridge handler and system browser

**Files:**
- Create: `src/Kustodian/Auth/EntraApp/SystemBrowser.cs`, `src/Kustodian/Bridge/Handlers/EntraAppHandler.cs`
- Modify: `src/Kustodian/App/AppServices.cs` (one `EntraAppClient` over `_http`; register the handler beside
  `AccountHandler`)
- Test: `tests/Kustodian.Tests/Bridge/EntraAppHandlerTests.cs`

**Interfaces:**
- Consumes: Tasks 2 and 3, `AccountService.ListAccountsAsync`, and `ActiveAccountAsync`.
- Produces:
  - `public interface ISystemBrowser { void Open(Uri url); }`. `SystemBrowser` accepts only `https://login.microsoftonline.com/` and
    `https://entra.microsoft.com/` URLs and throws otherwise. It opens with `open` on macOS, `xdg-open` on Linux, and `UseShellExecute` on Windows.
  - The bridge commands below. Payloads are camelCase.

  | Command | Payload |
  |---|---|
  | `entraApp.plan` | `{canCreate, reason?, defaultName, tenantId, tenantName, groups, tablesWithData, tablesWithoutData, writeOnlyTables}` |
  | `entraApp.create {name, permissions: [{resource, name}]}` | `CreateResult`; emits `entraApp.step {step}` |
  | `entraApp.retryServicePrincipal {appId, objectId}` | `CreateResult` |
  | `entraApp.consentStatus {appId}` | `{granted, missing}` |
  | `entraApp.canGrant` | `{canGrant: bool \| null}` |
  | `entraApp.openConsent {appId}` | `{}` |
  | `entraApp.consentLink {appId}` | `{url}` |
  | `entraApp.openPortal {appId}` | `{}`; opens `https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Overview/appId/{appId}` |

  - Every command reads the active account and the tenant (`TenantAsync`) itself and never trusts tenant or URL params.
  - `canCreate` is false with the spec 6.1 reason when the account isn't the Azure CLI client, is expired, or lacks
    `Application.ReadWrite.All` and `Directory.AccessAsUser.All`. In that case `plan` still returns the groups.
  - `create` validates the name (trimmed, 1 to 120 characters) and maps each `{resource, name}` back to a planned permission.
    An unknown or write permission is `badRequest`.

- [ ] **Step 1: Write failing tests.**
  - `Plan_cannot_create_without_scope`: the reason text matches the spec.
  - `Plan_cannot_create_for_own_client`.
  - `Create_rejects_write_or_unknown_permission`.
  - `Create_rejects_empty_or_long_name`.
  - `OpenConsent_builds_url_from_active_tenant`: a fake `ISystemBrowser` receives a URL with that tenant, the app ID and a
    `state`.
  - `ConsentLink_has_no_state`.
  - `SignIn_needed_maps_to_signInNeeded`.
  - `SystemBrowser_refuses_other_hosts`.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement and register.** Use the `BridgeException` codes as in `AccountHandler`. An `EntraAppException` maps
  to `failed` with its message and `{nothingCreated}` data, if the bridge supports error data; otherwise the message is enough.
- [ ] **Step 4: Run `dotnet test` and `dotnet build -warnaserror`.** Expected: PASS.
- [ ] **Step 5: Commit.** Message: `feat(kustodian): bridge commands for creating an Entra app`.

### Task 5: Web: choose-permissions dialog and Create

**Files:**
- Modify: `web/src/wire.ts` (types mirroring Task 4), `web/src/bridge.mock.ts` (answers for every `entraApp.*` command; a
  plan built from a small fixture)
- Create: `web/src/signin/permission-list.tsx`, `web/src/signin/create-app-dialog.tsx`
- Test: `web/src/signin/permission-list.test.tsx`, `web/src/signin/create-app-dialog.test.tsx`

**Interfaces:**
- Produces: `export function CreateAppDialog({ onClose, onSwitched }: { onClose: () => void; onSwitched: () => void })`.
  `onSwitched` fires after a successful sign-in with the new app, so `app.tsx` re-reads accounts.

Behaviour, per mockup `EntraApp`:

- **Layout.** Two columns:
  - the left holds groups, then subgroups, then rows, with a tri-state checkbox per group and subgroup;
  - the right holds the editable name (default from `plan`) and the "What will be created" summary.
- **Each row** shows:
  - the name in mono and an Admin tag;
  - "N tables: a, b, c …" with a "show all" disclosure;
  - when unticked, the "You lose N tables: …" line in warn color, computed like `LostTables`.
- **Footer:** "{n} permissions · {covered} of {tablesWithData} tables · {admin} need admin consent", and the muted line
  "{tablesWithoutData} more tables have no published delegated permission; {writeOnlyTables} are reachable only with write
  permissions, which Kustodian doesn't ask for."
- **Create:**
  - It is disabled with nothing ticked or a blank name.
  - Clicking it shows the step checklist from `entraApp.step`.
  - Esc and a click outside close the dialog only when not creating.
- **Failure.** With `nothingCreated`, show the alert and "Back to permissions" with the ticks kept. A result with a null
  `servicePrincipalId` goes to Task 6's created view with the warning.

- [ ] **Step 1: Write failing tests.**
  - `groups render with spec defaults`: Mail unticked, Security and Azure ticked.
  - `group checkbox is mixed when partly ticked`.
  - `unticking the only cover shows You lose`.
  - `footer totals update`.
  - `Create disabled for blank name`.
  - `Create sends ticked permissions and shows steps`.
  - `does not close while creating` (Review Focus 3).
  - `nothing-created failure keeps ticks`.
  - `Esc closes when idle`.
- [ ] **Step 2: Run `npm --prefix web test -- create-app-dialog permission-list`.** Expected: FAIL.
- [ ] **Step 3: Implement** with the existing `card`, `btn`, `chip`, `tag` and `field` classes and Tailwind, like
  `sign-in.tsx`. State stays in React only.
- [ ] **Step 4: Run `npm --prefix web run lint`, `npm --prefix web run typecheck` and `npm --prefix web test`.** Expected:
  PASS, with only the known open warnings.
- [ ] **Step 5: Commit.** Message: `feat(kustodian): choose permissions and create an Entra app`.

### Task 6: Web: created view, consent, switching, entry points

**Files:**
- Modify: `web/src/signin/create-app-dialog.tsx`, `web/src/signin/sign-in.tsx`, `web/src/app.tsx`,
  `web/src/results/run-status.tsx`
- Test: `web/src/signin/create-app-dialog.test.tsx`, `web/src/signin/sign-in.test.tsx`, `web/src/results/run-status.test.tsx`

Behaviour, per mockups `EntraAppCreated` and `EntraAppRefused`:

- **Created** shows:
  - the name, the client ID and tenant ID with Copy buttons (`navigator.clipboard.writeText`);
  - "Open in Entra admin center", through `entraApp.openPortal {appId}`.
- **Step 1, Grant for the whole tenant:**
  - "Open admin consent page", "Copy link for an admin" and "Check again";
  - a primary button chosen by `entraApp.canGrant` (true: open; false: copy, plus the spec 7 line; null: equal);
  - the admin-approval warning when any ticked permission is admin;
  - Check again shows "Granted for the tenant: X of Y" or names what is missing.
- **When the service principal is missing:** the warning plus "Try again" (`entraApp.retryServicePrincipal`).
- **Step 2, What now?:**
  - **Switch to this app and sign in:** `settings.get`, then `settings.set` with `signIn: {clientId: appId, tenant: tenantId}`,
    then `account.signIn {clientId, tenant, deviceCode: false}`, then `onSwitched()`.
  - **Just show me the client ID:** closes the dialog with nothing saved.
  - A sign-in error containing `AADSTS65001` or `AADSTS90094` shows "This app still needs an admin to grant its permissions"
    and returns to step 1.
- **Entry points:**
  - In `sign-in.tsx`'s "What this sign-in can read" card: the button **Create Entra ID application…** for an Azure CLI active
    account that isn't expired. When `entraApp.plan` says `canCreate: false`, it is disabled with the reason as a muted line.
  - In `app.tsx`: the command `{ id: 'account.createEntraApp', title: 'Create Entra ID application', group: 'Account' }`,
    enabled under the same conditions from the account list. It opens the sign-in screen (`setAccountsOpen(true)`) with the
    dialog open.
  - In `run-status.tsx`: with `outcome === 'noPermission'` and an Azure CLI active account, a **Create Entra ID application…**
    button that runs the command.

- [ ] **Step 1: Write failing tests.**
  - `primary consent button follows canGrant`.
  - `check again lists missing scopes`.
  - `switch writes settings then signs in`.
  - `just show closes without settings.set`.
  - `consent error on switch returns to grant step`.
  - `retry service principal`.
  - `button hidden for own client and expired account`.
  - `button disabled with reason`.
  - `noPermission shows create button for Azure CLI only`.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run lint, typecheck and test.** Expected: PASS.
- [ ] **Step 5: Commit.** Message: `feat(kustodian): admin consent and switching to the new Entra app`.

### Task 7: Manual checks, full gate, PR

**Files:**
- Modify: `docs/manual-checks.md` (the five manual checks from spec section 10, for the owner)

- [ ] **Step 1: Add the manual checks.**
- [ ] **Step 2: Run the full gate.** From `kustodian/`:
  - `dotnet build -warnaserror`;
  - `dotnet test`;
  - `npm --prefix web run lint`;
  - `npm --prefix web run typecheck`;
  - `npm --prefix web test`;
  - `npm --prefix web run build`.

  Expected: everything passes, with only the known warnings.
- [ ] **Step 3: Run the app** with the bridge mock (`npm --prefix web run dev`) and walk the three mockup states. No real
  tenant is used.
- [ ] **Step 4: Commit, push the branch, and open a PR to `main`** that links the spec and the manual checks.
