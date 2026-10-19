import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadDiff } from "../src/git.ts";
import { makeFixtureRepo } from "./fixture-repo.ts";

const BIN = fileURLToPath(new URL("../bin/follow-me.ts", import.meta.url));

function run(dir: string, ...args: string[]) {
  const r = spawnSync(BIN, args, { cwd: dir, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

test("extract, check, apply and status drive the whole flow from the command line", async (t) => {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  const tip = repo.branch.slice(0, 12);
  const base = repo.base.slice(0, 12);

  assert.deepEqual(run(repo.dir, "extract"), {
    code: 0,
    out: [
      `feature ${tip} onto main ${base}: 8 files, 9 units`,
      "  M README.md        1 hunk, 6 change lines",
      "  M assets/logo.bin  binary",
      "  M notes.txt        1 hunk, 3 change lines",
      "  M scripts/run.sh   mode 100644 -> 100755",
      "  A src/guard.js     1 hunk, 3 change lines",
      "  M src/lib.js       2 hunks, 11 change lines",
      "  A src/new-name.js  1 hunk, 1 change line",
      "  D src/old-name.js  1 hunk, 1 change line",
      "session .follow-me/feature",
      "",
    ].join("\n"),
    err: "",
  });

  const diff = await loadDiff(repo.dir, "main", "feature");
  const ids = [...diff.units.keys()];
  const [readme] = ids;
  assert.ok(readme);
  const draftPath = join(repo.dir, ".follow-me", "feature", "draft.json");
  const draft = (commits: { message: string; units: string[] }[]) =>
    writeFileSync(
      draftPath,
      JSON.stringify({ schema: "follow-me/plan@1", base: repo.base, tip: repo.branch, commits }),
    );

  draft([{ message: "docs: readme", units: [`${readme}:0-2`] }]);
  const failing = run(repo.dir, "check");
  assert.equal(failing.code, 1);
  assert.equal(failing.out.split("\n")[0], `${readme}:3-5 (README.md) is in no commit`);

  draft([
    { message: "docs: readme", units: [readme] },
    { message: "feat: everything else", units: ids.slice(1) },
  ]);
  const ok = run(repo.dir, "check");
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /^ok: 2 commits, plan [0-9a-f]{12}\n/);
  assert.equal(
    ok.out.split("\n").slice(1).join("\n"),
    [
      "  1  docs: readme  (1 unit, 1 file)",
      "  2  feat: everything else  (8 units, 7 files)",
      "",
    ].join("\n"),
  );

  const before = git(repo.dir, "rev-parse", "HEAD");
  const applied = run(repo.dir, "apply");
  assert.equal(applied.code, 0, applied.err);
  const head = git(repo.dir, "rev-parse", "feature-split");
  const tree = git(repo.dir, "rev-parse", "feature^{tree}");
  assert.equal(
    applied.out,
    [
      `created feature-split at ${head.slice(0, 12)} from plan v1 (2 commits)`,
      `proof: feature-split^{tree} ${tree} equals feature^{tree} ${tree}`,
      "",
    ].join("\n"),
  );
  assert.equal(
    run(repo.dir, "apply").out.split("\n")[0],
    `unchanged feature-split at ${head.slice(0, 12)} from plan v1 (2 commits)`,
  );
  assert.equal(git(repo.dir, "rev-parse", "HEAD"), before);
  assert.equal(git(repo.dir, "status", "--porcelain"), "");

  assert.deepEqual(run(repo.dir, "status"), {
    code: 0,
    out: [
      `feature ${tip} onto main ${base}`,
      "units: 9 units",
      "draft: .follow-me/feature/draft.json",
      "plans: v1",
      "reviews: none",
      `applied: plan v1 as feature-split at ${head.slice(0, 12)}`,
      "",
    ].join("\n"),
    err: "",
  });
  assert.deepEqual(run(repo.dir, "feedback"), {
    code: 1,
    out: "",
    err: "follow-me: no review yet, run `follow-me review` first\n",
  });
  const prompt = run(repo.dir, "prompt");
  assert.equal(prompt.code, 0, prompt.err);
  assert.match(prompt.out, /^# follow-me: plan the commits\n/);
  assert.match(prompt.out, /## Previous plan/);
});
