# Changelog

All notable changes to RootScribe are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-05-16

First tagged release. Hotfix on top of the unreleased `0.1.0` baseline so
the Plaud sync poller works against Cloudflare's bot WAF, plus repository
hygiene needed to publish.

### Fixed

- **Plaud Cloudflare 403 challenge — DEVX-314.** The self-identifying
  `rootscribe/0.1.0 (+url)` User-Agent started triggering Cloudflare's bot
  WAF on 2026-05-15, returning a 403 challenge page to the sync poller.
  Token auth was unaffected; the request never reached Plaud's origin.
  Swapped `USER_AGENT` in `server/src/plaud/client.ts` to a Chrome string.
- **Structural UA lock — DEVX-314.** `user-agent` is now applied AFTER the
  `init.headers` spread inside `plaudFetch`, so callers cannot override it
  back to a bot-pattern UA. The previous merge order would have let a
  future caller defeat the regression test by passing their own header.
- Two regression tests in `server/src/plaud/client.test.ts` forbid any UA
  matching `^name/ver (+http...)` on **both** the default-headers path
  AND the caller-override path. Intentionally stricter than pinning the
  Chrome string so DEVX-314's follow-up env-var work doesn't break them.

### Added

- `CHANGELOG.md` (this file). Format follows
  [Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/) +
  [SemVer 2.0](https://semver.org/spec/v2.0.0.html).

### Removed

- Workspace-root `.mcp.json`. The inbox MCP is now provided via the
  seedkit plugin's plugin-level `.mcp.json`, so the workspace-root copy
  was stale.

### Deferred to a follow-up under DEVX-314

- `PlaudEdgeBlockedError` — a dedicated error class for Cloudflare 403
  challenges, distinct from generic `PlaudApiError` and from
  `PlaudAuthError`, so operators can immediately tell an edge block from
  an auth problem.
- `ROOTSCRIBE_PLAUD_USER_AGENT` env var — operator-overridable UA so
  future Cloudflare rule changes can be worked around without a code
  change. The locked default stays the Chrome string above.

## [0.1.0] — unreleased baseline

The pre-hotfix RootScribe baseline. Never formally tagged but the version
identifier was live in code (the broken UA self-identified as
`rootscribe/0.1.0`). Forked from
[`rsteckler/applaud`](https://github.com/rsteckler/applaud) at `v0.5.6`
(upstream commit `da7ae11`). 135 commits across 6 DEVX tickets
(DEVX-96, DEVX-99, DEVX-100, DEVX-101, DEVX-102, DEVX-103) plus the
foundational inbox-MCP work that motivated the fork.

### Added

#### Inbox workflow + MCP server (foundational)

- New `inbox-mcp/` workspace exposing the recordings inbox as a Model Context
  Protocol stdio server (categorize, tag, snooze, archive, link-Jira,
  list-new, search, mark-reviewed). Registered as a project-scoped MCP server
  so Claude Code can manage the inbox without leaving the editor.
- v4 SQLite schema migration introducing categories, tags, snooze, review
  state, and Jira links on the `recordings` table. Migration is transactional
  with a nudge-overlap guard.
- Standardized snooze comparison (`<=`) across all query sites
  (`unnotifiedNew`, `listNew`, tag-filtered branches).

#### Inbox UI + Jira integration — DEVX-96, DEVX-99

- Surfaced the inbox workflow in the RootScribe web app (Dashboard,
  RecordingDetail, Settings).
- Auto-linked Jira issue keys from a configurable `jiraBaseUrl`.
- Tag and category autocomplete on detail-page editors.
- DB index on `recordings.category` to accelerate facet DISTINCT scans.

#### Testing + CI/CD infrastructure — DEVX-100

- Vitest workspace, ESLint flat config, Playwright, and GitHub Actions CI
  scaffolded from scratch.
- Baseline Vitest unit tests across all four packages (`server/`, `web/`,
  `inbox-mcp/`, `shared/`).
- Playwright smoke tests + per-PR workflow.
- Pre-push guard (`.githooks/pre-push`) and `scripts/dev-setup.sh` to prevent
  PRs from being mis-targeted at the upstream `rsteckler/applaud` repo (see
  the DEVX-100 incident on 2026-04-18).
- Testing, CI/CD, and TDD expectations documented in README.

#### Coverage ratchets — DEVX-102 (ratchets #1–#7)

- Seven incremental coverage-ratchet PRs bringing the suite to
  **95.36 % statements / 86.59 % branches / 95.90 % functions / 97.10 % lines**
  across 776 unit tests plus Playwright journey specs.
- Major test additions:
  - `server/src/plaud/{client,detail,audio,list,transcript}.ts`
  - `server/src/sync/{state,events,layout,poller}.ts`
  - `server/src/routes/{recordings,media,sync,auth,config}.ts`
  - `server/src/auth/{browser-watch,chrome-leveldb,profiles}.ts`
  - `server/src/webhook/post.ts`
  - All `web/src/components/*`, `web/src/routes/*`, and
    `web/src/routes/setup/*` components
  - `inbox-mcp` platform branches
- Playwright `globalSetup` seam that seeds state before `webServer` boots,
  plus four end-to-end journey specs.
- Coverage thresholds pinned in `vitest.config.ts` just below the achieved
  baseline so future regressions fail CI.

### Changed

#### Major dependency upgrades — DEVX-101

| Package | From | To |
| --- | --- | --- |
| React | 18 | 19 |
| Vite | 5 | 8 |
| TypeScript | 5.6 | 6 |
| Tailwind | 3 | 4 |
| Express | 4 | 5 |
| Zod | 3 | 4 |
| ESLint | 9 | 10 |
| Vitest | 2 | 4 |
| better-sqlite3 | 11 | 12 |

Notable compatibility fixes that rode along with the upgrade:

- SPA fallback rewritten for Express 5's stricter dotfile rejection.
- Vite dev host pinned to IPv4 to work around Vite 8's IPv6-default
  regression.

#### Rebrand — DEVX-103

- Renamed `applaud` / `Applaud` to `rootscribe` / `RootScribe` across
  packages, identifiers, paths, and user-facing copy.

#### Hardening — DEVX-96

- `jiraBaseUrl` restricted to `http://` and `https://` schemes.
- Defense-in-depth href-scheme check on user-supplied URLs.
- List pagination clamped to safe integer ranges.
- `PATCH /status` notes contract tightened.

### Fixed

- Settings save-error now clears on field edits.
- Suppress the server's first-run browser popup during Playwright e2e runs.

> The Plaud Cloudflare 403 hotfix and `.mcp.json` removal land in
> [0.1.1](#011--2026-05-16), not here. They're the reason 0.1.0 was
> never published.

### Removed

- Unused `@applaud/shared` dependency from `inbox-mcp`.

### Repository conventions established this release

- **Canonical home:**
  [`Root-Functional-Medicine/rootscribe`](https://github.com/Root-Functional-Medicine/rootscribe).
  `origin` points here. `upstream` is `rsteckler/applaud` and is read-only;
  the pre-push hook aborts any push to `upstream`.
- **Branch naming:**
  `<github-username>/DEVX-<ticket>-<kebab-case-summary>`.
- **Commit messages:** start with the ticket key — `DEVX-<N> Short description`.
- **PR titles:** mirror commit subjects — `DEVX-<N>: Short description`.
- **Jira project:**
  [DEVX](https://rootfunctionalmedicine.atlassian.net/browse/DEVX).
- `gh repo set-default Root-Functional-Medicine/rootscribe` runs once per
  clone (handled by `scripts/dev-setup.sh`) to prevent `gh` from defaulting
  to the upstream fork.

[0.1.1]: https://github.com/Root-Functional-Medicine/rootscribe/releases/tag/v0.1.1
[0.1.0]: https://github.com/Root-Functional-Medicine/rootscribe/compare/da7ae11...v0.1.1
