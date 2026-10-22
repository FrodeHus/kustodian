# Entra ID permissions

Kustodian signs in as you and calls Microsoft's APIs with **delegated permissions**. What a query can read is limited by two
things:

1. The permissions the **client app** you sign in with has been granted in your tenant.
2. Your own access: your Entra roles, Azure RBAC assignments and the tenant's licenses. A permission never lets you see more
   than your account could see anyway.

The sign-in screen lists the scopes the current sign-in has under **What this sign-in can read**. A table you can't read
answers "No permission" when you run it, and **Explain** lists the permissions a query needs before you send it.

## The default: the Azure CLI client

With no setup, Kustodian signs in with Microsoft's public Azure CLI client (`04b07795-8ddb-461a-bbee-02f9e1bf7b46`). Most
tenants have already consented to what it asks for, so it is a good starting point for common Microsoft Graph directory data
(users, groups, applications and the like) and for Azure Resource Graph.

Its permissions are fixed by Microsoft, though, and you can't add to them. Security data, audit logs, Defender advanced
hunting (`ThreatHunting.Read.All`) and other data behind specific permissions are often out of reach. For those, use your own
app registration with the permissions your queries need.

## Your own app registration

You can let Kustodian create the app registration for you, or create it yourself in the Microsoft Entra admin center. Either
way, permissions that need admin consent have to be granted by an administrator once for the whole tenant.

### Option A: let Kustodian create it

You need:

- To be signed in with the Azure CLI client, with `Application.ReadWrite.All` or `Directory.AccessAsUser.All` among its scopes.
  Kustodian disables the button and says so when the sign-in lacks them.
- Permission to register applications: the tenant setting **Users can register applications**, or a role such as Application
  Developer.

Steps:

1. Sign in with **Azure CLI (default)**.
2. On the sign-in screen, under **What this sign-in can read**, choose **Create Entra ID application…** (also in the command
   palette).
3. Review the permissions. Kustodian proposes the smallest set of read permissions that covers the Graph tables, grouped by
   area, plus `ThreatHunting.Read.All` for advanced hunting and Azure Service Management `user_impersonation` for Resource
   Graph. Untick what you don't need; the dialog shows which tables you would lose. *Mail, Teams and files*, *Reports and
   usage* and *Other* start unticked.
4. Name the app and create it. Kustodian creates the app registration as a public client (redirect URIs `http://localhost`
   and `https://login.microsoftonline.com/common/oauth2/nativeclient`), adds you as an owner and creates its service principal
   (the enterprise application).
5. Grant admin consent for permissions that need it:
   - If you hold an active role that can grant tenant-wide consent, such as Global Administrator, Privileged Role
     Administrator, Cloud Application Administrator or Application Administrator, grant it from Kustodian.
   - Otherwise, copy the consent link and send it to an administrator, then choose **Check again**.

   If Kustodian couldn't create the service principal, the admin's consent creates it.
6. Choose what happens next:
   - **Switch and sign in** saves the app as your default client and tenant and signs you in with it. Your Azure CLI sign-in
     stays in the account list.
   - **Just show me the client ID** saves nothing; use it later under **My own app registration**.

### Option B: create it in the Entra admin center

1. Open the [Microsoft Entra admin center](https://entra.microsoft.com) and go to **Entra ID › App registrations › New
   registration**.
2. Name the app (for example *Kustodian*) and choose **Accounts in this organizational directory only**.
3. Under **Redirect URI**, choose **Public client/native (mobile & desktop)** and enter `http://localhost`. Select **Register**.
4. On the app's **Overview**, copy the **Application (client) ID** and the **Directory (tenant) ID**.
5. Under **Authentication**, set **Allow public client flows** to **Yes**. Kustodian's device code sign-in needs it.
6. Under **API permissions › Add a permission**, add **delegated** permissions for the data you query:
   - **Microsoft Graph**: the read permissions your tables need. Explain shows them per table; the table below lists common
     ones.
   - **Microsoft Graph** `ThreatHunting.Read.All` for Defender advanced hunting.
   - **Azure Service Management** `user_impersonation` for Azure Resource Graph.
7. Select **Grant admin consent for *your tenant***. This needs an administrator; without it, permissions that need admin
   consent stay unusable.
8. In Kustodian, on the sign-in screen, choose **My own app registration**, enter the client ID and tenant ID, and sign in.
   To make it the default, set **Default client ID** and **Default tenant** in Settings.

Common Microsoft Graph permissions:

| Data | Delegated permission |
| --- | --- |
| Users | `User.Read.All` |
| Groups and members | `Group.Read.All` or `GroupMember.Read.All` |
| Applications and service principals | `Application.Read.All` |
| Devices | `Device.Read.All` |
| Sign-in and audit logs | `AuditLog.Read.All` |
| Risky users | `IdentityRiskyUser.Read.All` |
| Conditional Access and other policies | `Policy.Read.All` |
| Most directory objects | `Directory.Read.All` |
| Defender advanced hunting | `ThreatHunting.Read.All` |

Ask only for the read permissions you need. Kustodian doesn't need write permissions to query.

## Troubleshooting

- **A table answers "No permission"**: the sign-in lacks its permission. Check **What this sign-in can read**, run Explain on
  the query, and add the permission to your app registration.
- **The permission is listed but data is still missing**: your account's own roles or the tenant's licenses limit it. Sign-in
  logs, for example, need a role such as Reports Reader or Security Reader.
- **"Your tenant doesn't let you register applications"**: an administrator can turn on **Users can register applications**,
  give you the Application Developer role, or create the app for you (Option B).
- **You added permissions after signing in**: sign in again so the token picks them up.
