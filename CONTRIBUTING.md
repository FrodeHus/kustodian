# Contributing to Kustodian

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Before you start

- For anything larger than a small fix, open an issue first so we can agree on the approach.
- Search existing issues to avoid duplicates.
- Security issues go through [SECURITY.md](SECURITY.md), not public issues.

## Setting up

See [Building from source](README.md#building-from-source) for the requirements. Then:

```sh
dotnet build -warnaserror
dotnet test
cd web && npm ci && npm run lint && npm run typecheck && npm test
```

## Rules

- **Warnings are fixed, never suppressed.** `dotnet build -warnaserror`, `oxlint` and `tsc` must be clean. No
  `#pragma warning disable`, `[SuppressMessage]`, `<NoWarn>`, `oxlint-disable`, `@ts-ignore` / `@ts-expect-error`, and no
  lowered rule severities. The two known exceptions are listed in [CLAUDE.md](CLAUDE.md).
- **Tests come with changes.** xUnit for .NET code under `tests/`, Vitest next to the code under `web/src/`.
- **Follow the existing style.** [.editorconfig](.editorconfig) sets formatting; match the naming and comment density of the
  code around you.
- **Package versions** are managed centrally in [Directory.Packages.props](Directory.Packages.props).
- **Never log tokens** or `Authorization` headers, and never cache tokens in plain text.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep each pull request to one change, with a clear description of what and why.
3. Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages (`feat:`, `fix:`, `docs:`, `chore:` ...).
4. Make sure CI passes on all three platforms.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE), and to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
