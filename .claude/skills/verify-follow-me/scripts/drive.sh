#!/bin/sh
# Runs the split flow (extract, check with a planted error, apply, re-apply) against a fixture
# and writes the evidence to $ROOT/.follow-me-verify/$RUN_ID/split/.
# usage: FOLLOW_ME_HOME=<dir> RUN_ID=<id> drive.sh <fixture-dir>
set -eu
: "${FOLLOW_ME_HOME:?export FOLLOW_ME_HOME=\$(mktemp -d) so the run never touches the real server}"
: "${RUN_ID:?set RUN_ID}"
fixture=${1:?usage: drive.sh <fixture-dir>}
root=$(cd "$(dirname "$0")/../../../.." && pwd)
out="$root/.follow-me-verify/$RUN_ID/split"
mkdir -p "$out"

fm() { node "$root/bin/follow-me.ts" "$@"; }

# cap <name> <args...>: runs follow-me in the fixture, keeps stdout, stderr and exit code.
cap() {
  name=$1; shift
  echo "follow-me $*" > "$out/$name.cmd"
  code=0
  (cd "$fixture" && fm "$@") > "$out/$name.out" 2> "$out/$name.err" || code=$?
  echo "$code" > "$out/$name.code"
  echo "$name: exit $code"
}

# write_draft <n>: n = 0 plants an error (the last unit left out), otherwise two commits.
write_draft() {
  FIXTURE=$fixture ROOT=$root PLANT=$1 node --input-type=module -e '
    const { loadDiff } = await import(process.env.ROOT + "/src/git.ts");
    const { writeFileSync } = await import("node:fs");
    const diff = await loadDiff(process.env.FIXTURE, "main", "feature");
    const units = [...diff.units.keys()];
    const planted = process.env.PLANT === "0";
    const cut = Math.ceil(units.length / 2);
    const commits = [
      { message: "feat: first half of the change", units: units.slice(0, cut) },
      { message: "feat: second half of the change", units: units.slice(cut, planted ? -1 : undefined) },
    ];
    writeFileSync(
      process.env.FIXTURE + "/.follow-me/feature/draft.json",
      JSON.stringify({ schema: "follow-me/plan@1", base: diff.base, tip: diff.tip, commits, responses: [] }),
    );
  '
}

cap extract extract --base main
write_draft 0
cap check-planted check
write_draft 1
cap check check
cap apply apply
cap apply-again apply
cap status status

git -C "$fixture" log --oneline feature-split > "$out/split-log.txt"
git -C "$fixture" status --porcelain > "$out/fixture-status.txt"
{
  echo "feature^{tree}      $(git -C "$fixture" rev-parse 'feature^{tree}')"
  echo "feature-split^{tree} $(git -C "$fixture" rev-parse 'feature-split^{tree}')"
  echo "feature             $(git -C "$fixture" rev-parse feature)"
} > "$out/trees.txt"
cp "$fixture"/.follow-me/feature/plans/*.json "$out/" 2>/dev/null || true
echo "evidence: $out"
