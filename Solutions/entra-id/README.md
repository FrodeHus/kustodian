# Entra ID

Reviews for Microsoft Entra ID, in three parts. Install the parts you need: each workbook and its queries work on their own.

| Part | Workbook | Queries | Needs |
| --- | --- | --- | --- |
| Break-glass accounts | `break-glass-compliance` | `btg-*` | `Directory.Read.All`, `Policy.Read.All`, `Policy.Read.AuthenticationMethod`, `RoleManagement.Read.Directory`, `AuditLog.Read.All`, `UserAuthenticationMethod.Read.All`; Global Reader; Entra ID P1 |
| Risky users | `risky-users-review` | `risky-users`, `risky-signins` | `IdentityRiskyUser.Read.All`; Entra ID P2 |
| MFA and passkey adoption | `mfa-adoption` | `mfa-by-company`, `users-missing-passkey` | `AuditLog.Read.All`, `User.Read.All`; Reports Reader; Entra ID P1 |

## Break-glass account compliance

Checks that each break-glass account will still work the one time you need it, after the
[break-the-glass compliance monitor](https://github.com/FrodeHus/btg-compliance-audit) runbook, but read live from Graph
with no Azure deployment.

Enter the accounts in **Break-glass accounts**, one UPN per line, and the groups that hold them in **Break-glass groups**,
by display name. Both keep your last value on this computer. Every widget uses them.

Each check gives a row with a category, a check id (the same ids as the runbook), a target, a status and a detail. **FAIL**
and **ERROR** need action; **ERROR** means the check couldn't read what it needs, which is a blind spot, not a pass. A check that needs a list Graph didn't return (an account's groups or owned objects, a
group's owners or members) is ERROR, never PASS.

| Category | Checks |
| --- | --- |
| `CA` | Each account is excluded from every enabled, report-only or disabled Conditional Access policy, directly or through a group. An exclusion by role doesn't count. |
| `ACCT` | Enabled, cloud-only, a member, UPN on `*.onmicrosoft.com`, no licenses, password never expires, a FIDO2 security key and no other method, at least two FIDO2 keys (WARN with one), per-user MFA disabled, owns nothing, password age. |
| `ROLE` | Permanent, active, tenant-wide Global Administrator (directly or through a role-assignable group), no PIM-eligible roles, no other roles. |
| `GRP` | Each group is role-assignable, static, cloud-only, a plain security group, has no owners and only users, holds no account missing from Accounts, and is excluded from every enabled policy. |
| `USE` | No sign-in, interactive or not, within **No sign-ins in the last**, from the account's sign-in activity. |
| `TNT` | At least two accounts, Entra ID P1 or P2, Security Defaults off, the FIDO2 method enabled for each account (all users, the account or a group it is in) and not excluding any, and, as INFO, the key models an enforced allow-list lets register. |
| `SYS` | Each UPN in Accounts belongs to a user, and each name in Break-glass groups to a group. |

The **Overview** tab shows every category except `GRP`. The group checks are on the **Groups** tab only: Graph can't
filter on an empty list, so with no group given they read every group in the tenant, which is slow in a large one. A tab
runs its queries only when you open it.

Different from the runbook:

- Only FIDO2 security keys (`passKeyDeviceBound`) count as allowed methods. A passkey in Microsoft Authenticator is an
  "other method", since it lives on a phone.
- Exclusions and roles are checked through the groups an account is a direct member of, not nested groups.
- The key count and per-user MFA state are read one account at a time (`users.authenticationMethods` and
  `users.authenticationRequirements`), which needs `UserAuthenticationMethod.Read.All` and `Policy.Read.All`; without them
  those checks are ERROR.
- Whether the break-glass keys' models are on an enforced allow-list is checked by hand, from the INFO row. The Overview tab
  lists what to check by hand.

## Risky users

Lists the users Microsoft Entra ID Protection flags as risky, and the recent sign-ins of those users.

- Query `risky-users`: risky users at the chosen risk levels.
- Query `risky-signins`: sign-ins of those users over a lookback period.
- Workbook `risky-users-review`: a short guide, a count of risky users and a table of them.

## MFA and passkey adoption

Shows how far your passkey rollout has come, overall and by company.

- How many users have a passkey, how many have only app or phone MFA, and how many have no MFA at all.
- Which companies have the most users still missing a passkey or MFA.
- Which methods people actually sign in with, over a period you choose.
- How many users have a passkey, an authenticator app or no MFA, which methods people register, and which admins still
  have no passkey.

How it counts:

- **Passkey:** a device-bound passkey is registered (`passKeyDeviceBound` or `passKeyDeviceBoundAuthenticator`).
- **Missing passkey:** some MFA method is registered, but no passkey.
- **No MFA:** no method is registered.
- **Sign-ins by method** counts successful authentication steps per method over **Sign-ins from the last** (1, 7, 14
  or 30 days; Graph keeps 30), hourly for one day and daily otherwise. A sign-in with a password and an app notification
  counts once for each. **Methods** picks which to show, or All. Method names are the ones the sign-in log reports; one
  missing from the list isn't shown.
- **Overall numbers** (the stats, the pie, coverage, methods and both tables) count every user in the registration report.
- **Company** (the company chart only): `extensionAttribute1` when it is set, otherwise `companyName`, in lower case. Users
  with neither are left out of that chart. **Hide companies with this many users or fewer** (default 10) keeps small groups
  out of it.

The table at the bottom of **MFA and passkey adoption** lists every user still missing a passkey, ready to export for your
rollout.
