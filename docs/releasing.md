# Releasing Kustodian

A release is cut by one run of `.github/workflows/release.yml`. It moves the Unreleased changelog entries under the new
version, sets the version in `Directory.Build.props`, tags `main`, builds every package from that commit and creates a
draft GitHub release "Kustodian x.y.z" with the packages and `SHA256SUMS.txt`. Nothing is published until you publish the
draft.

## Changelog entries

Every pull request that changes the app (`src/` or `web/`) adds a line under `## [Unreleased]` in
[../CHANGELOG.md](../CHANGELOG.md), in an Added, Changed or Fixed group. `.github/workflows/changelog.yml` checks this on
each pull request and fails when the Unreleased section is unchanged. Tests, CI, docs, the site, the release tooling and
the dependency files Dependabot bumps (`Directory.Packages.props`, `web/package.json`, `web/package-lock.json`) are exempt.
For any other change with nothing to tell users, label the pull request **no changelog**.

The check exists because the release refuses an empty Unreleased section: notes missing from merged pull requests stop
the release at "Cut the release".

## Cutting a release

1. Make sure everything the release should contain is merged, that `ci` passed on `main`'s latest commit, and that
   `CHANGELOG.md` has its notes under `## [Unreleased]`.
2. Actions → release → *Run workflow*, on `main`, with the version (`1.2.3`; `v1.2.3` works too). That run, the
   `prepare` job:
   - refuses a version that isn't x.y.z or whose tag already exists;
   - checks that the latest `ci` run on `main` passed and is for `main`'s current commit, and stops otherwise;
   - runs `tools/release/cut-release.sh <version>`, which moves the Unreleased entries to `## [x.y.z] - YYYY-MM-DD` and
     sets `<Version>` in `Directory.Build.props` (it refuses an empty Unreleased section, or a version that already has a
     section);
   - commits that to `main` as "chore: version x.y.z" and pushes the annotated tag `vx.y.z`.
3. The tag push starts a second release run, which builds the packages and drafts the release. Watch it under
   Actions → release.
4. Review the draft on the [releases page](https://github.com/FrodeHus/kustodian/releases): the assets, the notes (the
   changelog section, install instructions and the signing note) and the checksums. Then publish it.
5. Check one package per platform, as in [manual-checks.md](manual-checks.md), and that `Kustodian --version` prints the
   version.

## Tagging by hand

Pushing a `v*` tag yourself also starts the build run, and skips step 2. The tag must point at a commit on `main` whose
`Directory.Build.props` has the same version and whose `CHANGELOG.md` has the `## [x.y.z]` section. Cut the release with
`tools/release/cut-release.sh <version>` in a pull request, merge it, then tag the merge commit. The build run's first job
refuses any other tag before anything is built or signed.

## Redoing a release

Delete the draft release and the tag, fix what was wrong on `main`, then push the tag again at a commit on `main` (see
[Tagging by hand](#tagging-by-hand)); the version commit and changelog section from the first try are already there.
`gh release create` fails if a release for the tag still exists.

## The deploy key and the rulesets

The version commit and the tag are pushed with the `RELEASE_DEPLOY_KEY` repository secret: the private half of the deploy
key "Github Actions Deploy", which has write access. The `main` ruleset lists *Deploy keys* as a bypass actor, which is
what lets the workflow commit without a pull request. The workflow token has no such bypass, and a tag it pushed would
not start a run.

To rotate the key, generate a new key pair, add the public half under Settings → Deploy keys with write access, replace
the secret, and remove the old key.

The rulesets:

- **main** (the default branch): no deletion, no force push, changes through a pull request, and the three `ci` checks
  (`build and test (windows-latest)`, `(macos-latest)` and `(ubuntu-latest)`) must pass on a branch that is up to date
  with `main`. Deploy keys and administrators may bypass it.
- **release** (`refs/tags/v*`): a release tag can't be deleted or moved. Deploy keys and administrators may bypass it,
  which is what lets you delete a tag to redo a release. It doesn't restrict who may create a tag; the build run's first
  job is what keeps a tag off `main`, or without its changelog section, away from the signing certificate and the
  release.

## Signing

The Windows MSIs are signed with a Certum certificate held in SimplySign when the `CERTUM_USERNAME`, `CERTUM_OTP_URI` and
`CERTUM_KEY_ID` secrets are set, and are built unsigned otherwise; the release notes say which. The Linux packages aren't
signed.

### macOS

The macOS app and dmgs are signed with a Developer ID Application certificate and notarized when all five secrets below
are set, and are ad-hoc signed otherwise; the release notes say which. They are the same values as Elevate's: a Developer
ID certificate belongs to the team, not to one app, and the app needs no provisioning profile (its token cache is in the
login keychain, which needs no entitlement).

| Secret | What it is |
| --- | --- |
| `MACOS_CERT_P12` | Base64 of the "Developer ID Application" certificate exported as a `.p12`, with its private key |
| `MACOS_CERT_PASSWORD` | The password set when exporting that `.p12` |
| `APPLE_ID` | The Apple ID e-mail address used for notarization |
| `APPLE_TEAM_ID` | The 10-character team ID (`VLJKN96D7N`) |
| `APPLE_APP_PASSWORD` | An app-specific password for that Apple ID (appleid.apple.com → Sign-In and Security) |

The macOS job imports the certificate into a temporary keychain and runs `tools/release/package.sh` with
`MACOS_SIGN_IDENTITY="Developer ID Application"`. For each runtime identifier the script signs `Kustodian.app` with the
hardened runtime, a secure timestamp and `tools/release/macos/Kustodian.entitlements` (JIT, writable and executable
memory, and no library validation, which the .NET runtime and the native libraries the single-file bundle extracts need),
runs `smoke.sh` on the signed app when it is the runner's own architecture, notarizes the app and staples the ticket,
zips it, then signs, notarizes and staples the dmg. A notarization that doesn't end Accepted fails the build; the notary
service's log is printed either way.

To sign a local build with the certificate in your login keychain, set `MACOS_SIGN_IDENTITY` (and the three `APPLE_*`
variables to notarize as well):

```sh
MACOS_SIGN_IDENTITY="Developer ID Application" tools/release/package.sh osx-arm64
```
