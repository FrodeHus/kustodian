# Security policy

## Supported versions

Only the latest release, and `main`, receive security fixes.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub:
[Report a vulnerability](https://github.com/FrodeHus/kustodian/security/advisories/new).

Include what you found, how to reproduce it, and the impact you expect. You should get a reply within a week. Once a fix is
released, the advisory is published with credit to you unless you prefer otherwise.

## Scope

Kustodian handles Microsoft Entra tokens for the signed-in user. Of particular interest:

- tokens or `Authorization` headers written to disk, logs or diagnostics;
- the local web UI reaching origins other than the app's own;
- query text or results sent anywhere other than Microsoft's APIs.
