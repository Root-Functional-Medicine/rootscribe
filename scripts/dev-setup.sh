#!/usr/bin/env bash
#
# One-shot developer setup for RootScribe. Run once after `git clone`.
#
# Configures the clone so `gh pr create` targets the internal repo (not the
# public fork source), activates the tracked pre-push guard, and verifies
# the git remotes are wired correctly.
#
# Idempotent — safe to re-run any time.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

INTERNAL_REPO="Root-Functional-Medicine/rootscribe"
UPSTREAM_REPO="rsteckler/applaud"

cd "${REPO_ROOT}"

say() { printf '\033[1;36m›\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing \`$1\` — install it and rerun"
}

require_cmd git
require_cmd gh

# --- git hooks -----------------------------------------------------------

say "configuring core.hooksPath = .githooks"
git config --local core.hooksPath .githooks
ok "hooks path set"

if [[ -f "${REPO_ROOT}/.githooks/pre-push" ]]; then
  chmod +x "${REPO_ROOT}/.githooks/pre-push"
  ok "pre-push hook executable"
else
  warn "no .githooks/pre-push hook found — skipping"
fi

# --- gh default repo -----------------------------------------------------

say "setting gh default repo to ${INTERNAL_REPO}"
if gh repo set-default "${INTERNAL_REPO}" >/dev/null 2>&1; then
  ok "gh default repo set"
else
  warn "gh repo set-default failed — are you authed? (\`gh auth status\`)"
fi

current_default="$(gh repo set-default --view 2>/dev/null || true)"
if [[ "${current_default}" != "${INTERNAL_REPO}" ]]; then
  warn "expected gh default repo '${INTERNAL_REPO}', got '${current_default:-unset}'"
fi

# --- remotes -------------------------------------------------------------

say "verifying git remotes"
origin_url="$(git config --get remote.origin.url 2>/dev/null || true)"
upstream_url="$(git config --get remote.upstream.url 2>/dev/null || true)"

case "${origin_url}" in
  *Root-Functional-Medicine/rootscribe*)
    ok "origin → Root-Functional-Medicine/rootscribe"
    ;;
  "")
    die "origin remote is not configured"
    ;;
  *)
    warn "origin points at ${origin_url} — expected Root-Functional-Medicine/rootscribe"
    ;;
esac

case "${upstream_url}" in
  "")
    warn "no upstream remote configured (optional; run \`git remote add upstream git@github.com:${UPSTREAM_REPO}.git\` if you want one)"
    ;;
  *"${UPSTREAM_REPO}"*)
    ok "upstream → ${UPSTREAM_REPO}"
    ;;
  *)
    warn "upstream points at ${upstream_url} — expected ${UPSTREAM_REPO}"
    ;;
esac

# --- summary -------------------------------------------------------------

echo
ok "RootScribe dev environment ready"
echo
echo "  PRs will target: ${INTERNAL_REPO}"
echo "  Pushes to \`upstream\` are blocked by .githooks/pre-push"
echo "  Re-run this script any time; it's idempotent."
