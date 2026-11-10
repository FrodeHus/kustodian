# Community Solutions

A solution is a ready-made set of saved queries and workbooks for one job, such as reviewing risky users. Open the
**Solutions** panel in the rail to browse them, read what each one does and install the parts you want.

The catalog is the `Solutions/` folder of [FrodeHus/kustodian](https://github.com/FrodeHus/kustodian) on `main`. A short
overview is also on the [Solutions page](https://frodehus.github.io/kustodian/solutions.html).

## Solutions that ship now

- **Entra ID**: three reviews in one solution. **Break-glass account compliance** checks that your emergency access
  accounts are excluded from Conditional Access, hardened, permanent Global Administrators and unused, for the accounts
  you list. **Risky users** lists users Entra ID Protection flags, with their recent sign-ins. **MFA and passkey adoption**
  shows passkey and MFA registration by company.
- **Defender vulnerability patch SLAs**: a patch SLA KPI per severity (for example 95% of critical exposures within 7
  days), the exposures past their window, and the trend of unique CVEs older than 90 days.
- **Defender for Cloud**: a posture workbook and 19 queries over Azure Resource Graph and advanced hunting. They cover
  secure score, recommendations and how long they have been unhealthy, vulnerability findings, regulatory compliance,
  Defender plans and their features, Defender for Servers Plan 2 coverage per subscription and per machine (including
  per-resource overrides), attack paths, governance status, alerts, sensitive control-plane operations, internet-exposed
  VMs and Defender for Endpoint onboarding.

## The panel

The panel lists each solution with its description, the sources it queries and how many queries and workbooks it holds.
**Installed** marks one you have installed. Find a solution with the search box, which matches its name, description, author and category, or narrow the list by category,
source, or **Show** (**All**, **Kustodian**, **Community** or **Installed**). Click a solution to open it: its README is on
the left and its items on the right.

Each solution has a badge:

- **Kustodian**: maintained by Kustodian.
- **Community**: written by someone else. The dialog adds **Not maintained by Kustodian. Review before running.** Read the
  queries before you run them.

A solution that needs a newer app shows **Needs Kustodian x.y.z** and can't be installed until you update Kustodian.

## Install

Tick or untick the items you want, then click **Install**. They go in a library folder named after the solution, each with
a new id, so they never overwrite something of yours. Nothing runs on install: queries and the workbook run when you open
them. A solution never installs a workspace: Kustodian removes any workspace from its queries and workbooks. Hunting queries
use **Primary workspace** until you pick one after installing, and Log Analytics queries wait for you to pick one.

## Uninstall

Open an installed solution and click **Uninstall**. It removes what the solution added and you haven't changed. An item you
changed stays in Saved as your own, and the dialog lists it under **These stay in Saved as your own.**

Uninstalling works offline and after a solution is withdrawn from the catalog: Kustodian keeps a copy of the solution's
manifest when it installs it, so an installed solution stays in the panel. When its README can't be loaded the dialog says
**Kustodian couldn't load the README.** in its place.

## Offline and downloads

The panel reads the catalog from `raw.githubusercontent.com`, refreshes it at most once an hour, and keeps the last one it
got. **Refresh** reads it again at once. When GitHub can't be reached the panel still opens with the kept catalog and says
**Showing the catalog from {time}. Kustodian couldn't reach GitHub.** Installing needs a connection.

Every solution file Kustodian downloads is checked against the SHA-256 and size in the catalog, and a file that doesn't
match is refused. The catalog index itself is read with a 4 MB limit.

## Not yet

Updating an installed solution, installing tools, and showing and granting the permissions a solution needs come in a later
version.

## Contributing a solution

Solutions are added with a pull request. [Solutions/README.md](../Solutions/README.md) describes the folder layout, the
manifest and how to build the index.
