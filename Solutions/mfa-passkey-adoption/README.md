# MFA and passkey adoption

Shows how far your passkey rollout has come, overall and by company.

## What it answers

- How many users have a passkey, how many have only app or phone MFA, and how many have no MFA at all.
- Which companies have the most users still missing a passkey or MFA.
- Which methods people actually sign in with, over a period you choose.
- How many users have a passkey, an authenticator app or no MFA, which methods people register, and which admins still
  have no passkey.

## How it counts

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

## How to use it

Open **MFA and passkey adoption** from Saved. The table at the bottom lists every user still missing a passkey, ready to
export for your rollout.

## Needs

`AuditLog.Read.All` and `User.Read.All`, the Reports Reader role (or higher) to read registration details, and a Microsoft
Entra ID P1 licence.
