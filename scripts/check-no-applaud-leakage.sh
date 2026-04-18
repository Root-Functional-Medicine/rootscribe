#!/usr/bin/env bash
#
# scripts/check-no-applaud-leakage.sh
#
# Guards against stale "applaud" references leaking back into the codebase
# after the RootScribe rename (DEVX-103). A handful of files intentionally
# retain "applaud" — to document the upstream fork source (rsteckler/applaud)
# and to enforce the pre-push guard that blocks pushes to that remote.
# Everything else must use "rootscribe" / "RootScribe".
#
# Run: ./scripts/check-no-applaud-leakage.sh
# Exit 0 when only allowlisted occurrences remain; 1 otherwise.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Files whose "applaud" occurrences document fork provenance, enforce the
# upstream push-guard, or are this script itself. Every remaining match
# must come from one of these paths.
allowlist_regex='^(CLAUDE\.md|\.githooks/pre-push|scripts/dev-setup\.sh|scripts/check-no-applaud-leakage\.sh):'

# git grep respects .gitignore (so node_modules/ etc. are skipped) and only
# searches tracked files. The lockfile is tracked and also checked.
matches=$(git grep -niE 'applaud' -- . || true)

if [ -z "${matches}" ]; then
  printf '\033[1;32m✓ No applaud references found anywhere.\033[0m\n'
  exit 0
fi

remaining=$(printf '%s\n' "${matches}" | grep -vE "${allowlist_regex}" || true)

if [ -n "${remaining}" ]; then
  printf '\033[1;31m✗ Found stale "applaud" references outside the fork-attribution allowlist:\033[0m\n' >&2
  printf '%s\n' "${remaining}" >&2
  printf '\nAllowlisted paths (fork-attribution / push-guard only):\n' >&2
  printf '  - CLAUDE.md\n  - .githooks/pre-push\n  - scripts/dev-setup.sh\n  - scripts/check-no-applaud-leakage.sh\n' >&2
  exit 1
fi

printf '\033[1;32m✓ Only allowlisted (fork-attribution) applaud references remain.\033[0m\n'
