#!/usr/bin/env bash
# usage: scripts/log-decision.sh <phase> <decision> <why> <evidence> <result>
set -euo pipefail
log="$(dirname "$0")/../docs/decisions.tsv"
[ -f "$log" ] || printf 'ts\tphase\tdecision\twhy\tevidence\tresult\n' > "$log"
clean() { printf '%s' "$1" | tr '\t\n' '  ' | sed -E "s/^([=+@-])/'\1/"; }
printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$(clean "$1")" "$(clean "$2")" "$(clean "$3")" "$(clean "$4")" "$(clean "$5")" >> "$log"
