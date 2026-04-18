# CLAUDE.md

Guidance for AI assistants (Claude Code, Copilot, Cursor, etc.) and humans working in this repository.

## Repository identity

- **Internal canonical home**: [`Root-Functional-Medicine/rootscribe`](https://github.com/Root-Functional-Medicine/rootscribe) — this is where PRs, issues, and releases live.
- **Upstream fork source**: [`rsteckler/applaud`](https://github.com/rsteckler/applaud) — RootScribe was forked from Applaud and extends it (inbox workflow, Jira integration, MCP server). Both repos are public.

`origin` points at `Root-Functional-Medicine/rootscribe`. `upstream` points at `rsteckler/applaud`. Never push to `upstream`. Never open PRs against `upstream`.

## Critical PR rule

**The `gh` CLI defaults to the "most recently seen" remote, which in a fork often means `upstream`.** On 2026-04-18 a DEVX-100 PR was accidentally opened against `rsteckler/applaud` because of this. It's closed now, but the commits remain in the upstream repo's git objects and can't be deleted.

### One-time setup per clone

Run this **before** your first `gh pr create` in this repo:

```bash
gh repo set-default Root-Functional-Medicine/rootscribe
```

This writes the default into `.git/config` for this clone. Every subsequent `gh pr create`, `gh issue create`, `gh pr view`, etc. will target the correct repo. Verify with:

```bash
gh repo set-default --view
# → Root-Functional-Medicine/rootscribe
```

### Safer invocations (belt + suspenders)

Even with `set-default` configured, be explicit when opening PRs — it's self-documenting and survives setup drift:

```bash
gh pr create \
  --repo Root-Functional-Medicine/rootscribe \
  --base main \
  --head "$(git branch --show-current)" \
  --draft \
  --title "DEVX-XXX: ..." \
  --body "..."
```

After `git push -u origin <branch>`, GitHub prints a URL like:

```
remote: https://github.com/<ORG>/<REPO>/pull/new/<branch>
```

**That URL is the authoritative PR target.** The `<ORG>/<REPO>` portion is what you pass to `--repo`. If it ever reads `rsteckler/applaud`, stop — something is wrong with your remote setup.

### Automated install

Run the dev-setup helper once per clone to handle `gh` defaulting and activate the pre-push guard:

```bash
./scripts/dev-setup.sh
```

This script:
1. Runs `gh repo set-default Root-Functional-Medicine/rootscribe`.
2. Sets `core.hooksPath = .githooks` so the tracked `pre-push` hook activates.
3. Confirms both remotes (`origin`, `upstream`) exist and point where expected.

## Pre-push guard

`.githooks/pre-push` runs on every `git push` once `core.hooksPath` is set. It **aborts** any push to `upstream` (rsteckler/applaud) and lets pushes to `origin` (Root-Functional-Medicine/rootscribe) through. Override with `--no-verify` only if you genuinely mean to push to upstream — in which case do it from the canonical `rsteckler/applaud` clone instead of this one.

## Workspace layout

Four packages via pnpm workspaces:

- `shared/` — TypeScript types and helpers shared by all consumers. No runtime deps.
- `server/` — Express + better-sqlite3 + Pino. Owns the Plaud sync loop, inbox CRUD, webhook dispatch.
- `web/` — React 18 + Vite + Tailwind. Talks to server via `/api` proxy.
- `inbox-mcp/` — MCP stdio server that exposes the inbox DB to Claude Code.

`@applaud/shared` is an internal workspace package. Its `main`/`types` point at `dist/`, so `pnpm -C shared build` must run before `pnpm typecheck`. The root `pnpm typecheck` script handles this automatically.

## Testing + CI

See **README.md → Running tests / CI/CD / Contributing**. Key points:

- One test harness across all packages (Vitest + Playwright). Root scripts: `pnpm test`, `pnpm test:coverage`, `pnpm test:e2e`, `pnpm ci`.
- Coverage thresholds are pinned just below the achieved baseline in `vitest.config.ts`. They ratchet up via [DEVX-102](https://rootfunctionalmedicine.atlassian.net/browse/DEVX-102).
- TDD is the default. Don't slip refactors or speculative abstractions into bug-fix or infra-only tickets.
- Never test mock behavior. Never add test-only methods to production classes. Mock only at the network boundary.

## Jira project

Issues live in the `DEVX` Jira project:
- `https://rootfunctionalmedicine.atlassian.net/browse/DEVX-<N>`
- Commit messages start with the ticket key: `DEVX-123 Short description`.
- PR titles mirror: `DEVX-123: Short description`.

## Branch naming

`<github-username>/DEVX-<ticket>-<kebab-case-summary>`. Example:

```
allenahner/DEVX-100-establish-automated-testing-suite-and-ci-cd-infrastructure-for-rootscribe
```

## When AI assistants are adding a new feature

- Read the Jira ticket first (`jira_get_issue DEVX-<N>`).
- For 3+ point stories, design an implementation plan before coding.
- Tests come before implementation, not after.
- Production code changes on infra-only tickets must be justifiable as "bug surfaced by new tests/lint/typecheck" — everything else belongs in its own ticket.
- Use `gh pr create --repo Root-Functional-Medicine/rootscribe ...` explicitly. Do not trust `gh`'s auto-detection.
