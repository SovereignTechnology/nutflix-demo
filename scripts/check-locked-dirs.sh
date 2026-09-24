#!/usr/bin/env bash
# Enforces SECURITY.md §locked / execution plan §0 rule 3.
#
# Until Stage 2 these paths held only interfaces, re-exports and tests. Stage 2 implemented
# them (2026-09-23); they stay the AUDIT SURFACE, read by the owner on every diff
# (.gitlab/CODEOWNERS). From Stage 3 on, this check enforces two standing rules on every
# non-test file there:
#
#   1. Nothing logs. No `console.*` and no logger calls: SECURITY.md invariant 7 says nothing
#      in these paths may log a proof, token or key, and the simplest proof is that nothing
#      logs at all (callers log outcomes, never inputs).
#   2. No model writes crypto. Imports from outside the package come only from the libraries
#      the audit surface is a thin wrapper over (cashu-ts, nostr-tools, sodium-universal,
#      compact-encoding) or from @sovit/core itself. A new dependency here — or a direct
#      curve/hash library such as @noble/* or node:crypto — is a reviewed change to this list.
#
# LOCKED_DIRS_UNLOCKED, which Stage 2 used to skip the old interface-only rule, is ignored.
#
# Usage: scripts/check-locked-dirs.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

LOCKED=(
  packages/core/src/payment
  packages/core/src/signer
  packages/core/src/pay-protocol
  packages/core/src/wallet/spend.ts
  packages/gateway/src/auth
)

# Module specifiers (exact, or a prefix ending in '/') the audit surface may import.
ALLOWED_IMPORTS=(
  @cashu/cashu-ts
  nostr-tools/
  sodium-universal
  compact-encoding
  @sovit/core
)

allowed_import() {
  local spec="$1" a
  [[ "$spec" == ./* || "$spec" == ../* ]] && return 0
  for a in "${ALLOWED_IMPORTS[@]}"; do
    if [[ "$a" == */ ]]; then [[ "$spec" == "$a"* ]] && return 0
    else [[ "$spec" == "$a" ]] && return 0
    fi
  done
  return 1
}

fail=0
for path in "${LOCKED[@]}"; do
  [[ -e "$path" ]] || continue
  while IFS= read -r -d '' f; do
    case "$f" in
      */__tests__/*|*.test.ts|*/README.md) continue ;;
      *.ts) ;;
      *) echo "LOCKED: non-TypeScript file in the audit surface: $f"; fail=1; continue ;;
    esac
    # Rule 1: no logging (comment lines excluded).
    if grep -nE '(^|[^A-Za-z0-9_.])(console\.[a-z]+|log(ger)?\.(trace|debug|info|warn|error|fatal|child))\s*\(' "$f" \
        | grep -vE '^[0-9]+:\s*(//|\*|/\*)'; then
      echo "LOCKED: logging in $f (see lines above). The audit surface never logs."
      fail=1
    fi
    # Rule 2: imports only from the allowlist — `… from 'x'`, a bare `import 'x'`, and
    # dynamic `import('x')` / `require('x')`.
    while IFS= read -r spec; do
      [[ -z "$spec" ]] && continue
      if ! allowed_import "$spec"; then
        echo "LOCKED: $f imports '$spec' — not in the audit-surface allowlist (scripts/check-locked-dirs.sh)."
        fail=1
      fi
    done < <(grep -ohE "(^|[[:space:]}])from[[:space:]]+['\"][^'\"]+['\"]|^[[:space:]]*import[[:space:]]+['\"][^'\"]+['\"]|(import|require)\([[:space:]]*['\"][^'\"]+['\"]" "$f" \
               | sed -E "s/.*['\"]([^'\"]+)['\"].*/\1/")
  done < <(find "$path" -type f -print0 2>/dev/null)
done

if [[ $fail -ne 0 ]]; then
  echo "check-locked-dirs: FAIL"
  exit 1
fi
echo "check-locked-dirs: OK"
