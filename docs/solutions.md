# Community Solutions

A solution is a ready-made set of saved queries and workbooks for one job, such as reviewing risky users. Open the
**Solutions** panel in the rail to browse them, read what each one does and install the parts you want.

The catalog is the `Solutions/` folder of [FrodeHus/kustodian](https://github.com/FrodeHus/kustodian) on `main`. A short
overview is also on the [Solutions page](https://frodehus.github.io/kustodian/solutions.html).

## Solutions that ship now

- **Entra risky users**: risky users from Microsoft Entra ID Protection, with their recent sign-ins, and a weekly review
  workbook.
- **MFA and passkey adoption**: passkey and MFA registration by company: who has a passkey, who has only app or phone MFA,
  and who has none.

## The panel

The panel lists each solution with its description, the sources it queries and how many queries and workbooks it holds.
**Installed** marks one you have installed. Find a solution by name with the search box, or narrow the list by category,
source, or **Show** (**All**, **Kustodian**, **Community** or **Installed**). Click a solution to open it: its README is on
the left and its items on the right.

Each solution has a badge:

- **Kustodian**: maintained by Kustodian.
- **Community**: written by someone else. The dialog adds **Not maintained by Kustodian. Review before running.** Read the
  queries before you run them.

A solution that needs a newer app shows **Needs Kustodian x.y** and can't be installed until you update Kustodian.

## Install

Tick or untick the items you want, then click **Install**. They go in a library folder named after the solution, each with
a new id, so they never overwrite something of yours. Nothing runs on install: queries and the workbook run when you open
them.

## Uninstall

Open an installed solution and click **Uninstall**. It removes what the solution added and you haven't changed. An item you
changed stays in Saved as your own, and the dialog lists it under **These stay in Saved as your own.**

## Offline and downloads

The panel reads the catalog from `raw.githubusercontent.com`, refreshes it at most once an hour, and keeps the last one it
got. **Refresh** reads it again at once. When GitHub can't be reached the panel still opens with the kept catalog and says
**Showing the catalog from {time}. Kustodian couldn't reach GitHub.** Installing needs a connection.

Every file Kustodian downloads is checked against the SHA-256 and size in the catalog. A file that doesn't match is
refused.

## Not yet

Updating an installed solution, installing tools, and showing and granting the permissions a solution needs come in a later
version.

## Contributing a solution

Solutions are added with a pull request. [Solutions/README.md](../Solutions/README.md) describes the folder layout, the
manifest and how to build the index.
