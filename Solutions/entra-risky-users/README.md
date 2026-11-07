# Entra risky users

Lists the users Microsoft Entra ID Protection flags as risky, and the recent sign-ins of those users.

## What you get

- Query `risky-users`: risky users at the chosen risk levels.
- Query `risky-signins`: sign-ins of those users over a lookback period.
- Workbook `weekly-review`: a short guide, a count of risky users and a table of them.

## What it needs

- Graph permission `IdentityRiskyUser.Read.All`.
- A Microsoft Entra ID P2 license (`AAD_PREMIUM_P2`) in the tenant.
