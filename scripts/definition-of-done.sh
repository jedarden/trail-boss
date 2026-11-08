#!/usr/bin/env bash
# Unified definition of done for trail-boss.
#
# Invoked identically by:
#   - NEEDLE validation gate (.needle.yaml: `scripts/definition-of-done.sh --fast`)
#   - Dispatch close verification (verified: block in the close reason)
#
# Lanes:
#   --fast   bun test only (daemon suite) — the NEEDLE gate lane
#   (none)   bun test + the bash regression gates
#
# Behavior: aggregates all failures rather than aborting on first.
# Returns non-zero if ANY check fails, with all failures reported.
#
# bun self-installs to ~/.bun/bin, which is only on PATH for interactive
# shells (~/.bashrc). Gate runners and clean extractions do not source it,
# so bootstrap PATH here — the same thing test-starvation-classification.sh
# does, and the same binary the trailboss-daemon systemd unit pins.

set -u

export PATH="$HOME/.bun/bin:$PATH"

lane="all"
if [ "${1:-}" = "--fast" ]; then
  lane="fast"
elif [ "${1:-}" != "" ]; then
  echo "usage: scripts/definition-of-done.sh [--fast]" >&2
  exit 2
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "bun not found (looked in PATH and $HOME/.bun/bin)" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

failures=()

run_check() {
  local name="$1"
  shift
  echo "=== $name ==="
  local status
  if "$@"; then
    status=0
    echo "[ok] $name"
  else
    status=$?
    echo "[FAIL] $name (exit $status)"
    failures+=("$name")
  fi
}

run_check "bun test" bun test
if [ "$lane" = "all" ]; then
  run_check "starvation classification regression" bash test-starvation-classification.sh
fi

if [ "${#failures[@]}" -gt 0 ]; then
  printf 'FAILED: %s\n' "${failures[@]}"
  exit 1
fi

echo "Definition of done satisfied (${lane} lane)."
