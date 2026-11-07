## What and why

<!-- What does this change, and why? Link the issue: Fixes #123 -->

## Checklist

- [ ] `dotnet build -warnaserror` and `dotnet test` pass
- [ ] `npm run lint`, `npm run typecheck` and `npm test` pass in `web/` (if the web UI changed)
- [ ] Tests added or updated
- [ ] No warning suppressions
- [ ] `CHANGELOG.md` updated for user-visible changes

### Solutions (if `Solutions/` changed)

- [ ] `solutionVersion` bumped in every changed solution
- [ ] Index regenerated
- [ ] No tenant data (tenant IDs, names, UPNs, IPs) in queries or samples
- [ ] Tools reviewed by Copilot (`tools.json` findings resolved)
