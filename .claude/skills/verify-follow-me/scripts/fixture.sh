#!/bin/sh
# Prints the path of a fresh disposable git repo: `main` plus a checked-out `feature` branch
# that covers every change kind. The caller removes it with `rm -rf`.
set -eu
root=$(cd "$(dirname "$0")/../../../.." && pwd)
exec node --input-type=module -e '
const { makeFixtureRepo } = await import(process.argv[1]);
console.log(makeFixtureRepo().dir);
' "$root/test/fixture-repo.ts"
