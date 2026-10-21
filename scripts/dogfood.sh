#!/usr/bin/env bash
# Splits this repo's own last commits with the naive planner and proves the tree is unchanged.
# usage: scripts/dogfood.sh   (DOGFOOD_DEPTH=6 sets how many commits back the base sits)
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
depth=${DOGFOOD_DEPTH:-6}
work=$(mktemp -d)
export FOLLOW_ME_HOME="$work/home"
mkdir -p "$FOLLOW_ME_HOME"
trap 'rm -rf "$work"' EXIT

fm() { node "$root/bin/follow-me.ts" "$@"; }
step() { printf '\n== follow-me %s\n' "$*"; }

git clone --quiet --no-local "$root" "$work/clone"
cd "$work/clone"
git switch --quiet -c dogfood
git rev-parse --verify --quiet "HEAD~$depth" >/dev/null ||
  { echo "dogfood: HEAD~$depth does not exist; fetch full history (fetch-depth: 0)" >&2; exit 1; }

step extract --base "HEAD~$depth"
fm extract --base "HEAD~$depth"
step plan --naive
fm plan --naive
step check
checked=$(fm check)
echo "$checked"
grep -q '^syntax: ' <<<"$checked" || { echo "dogfood: check ran no syntax gate" >&2; exit 1; }
step apply --no-sign
applied=$(fm apply --no-sign)
echo "$applied"

proof=$(grep '^proof: ' <<<"$applied" || true)
[[ "$proof" == *" equals "* ]] || { echo "dogfood: tree proof failed: $proof" >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo "dogfood: working tree is dirty" >&2; git status --porcelain >&2; exit 1; }
echo
echo "dogfood: ok, $(git rev-list --count "HEAD~$depth..dogfood-split") commits on dogfood-split"
echo "$proof"
