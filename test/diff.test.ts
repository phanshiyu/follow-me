import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { formatUnitRef, isSha, parseDiff, parseUnitRef, projectFile } from "../src/diff.ts";
import { loadDiff } from "../src/git.ts";
import type { Diff, Sha, Unit } from "../src/types.ts";
import { addWholeFileKinds, makeFixtureRepo } from "./fixture-repo.ts";

function describeUnit(u: Unit): string {
  if (u.kind === "hunk") return `${u.path} hunk ${u.changeCount}`;
  if (u.kind === "file") return `${u.path} file ${u.reason}`;
  return `${u.path} mode ${u.from}->${u.to}`;
}

function gitShow(dir: string, spec: string): string | null {
  try {
    return execFileSync("git", ["cat-file", "blob", spec], {
      cwd: dir,
      encoding: "latin1",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function sha(s: string): Sha {
  assert.ok(isSha(s));
  return s;
}

test("every change kind in the fixture yields the expected units, in diff order", async (t) => {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  const diff = await loadDiff(repo.dir, "main", "feature");
  assert.deepEqual([...diff.units.values()].map(describeUnit), [
    "README.md hunk 6",
    "assets/logo.bin file binary",
    "notes.txt hunk 3",
    "scripts/run.sh mode 100644->100755",
    "src/guard.js hunk 3",
    "src/lib.js hunk 4",
    "src/lib.js hunk 7",
    "src/new-name.js hunk 1",
    "src/old-name.js hunk 1",
  ]);
  assert.equal(diff.base, repo.base);
  assert.equal(diff.tip, repo.branch);
});

test("symlink, empty file, type change and gitlink become whole-file units", async (t) => {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  addWholeFileKinds(repo);
  const diff = await loadDiff(repo.dir, "main", "feature");
  const whole = [...diff.units.values()].filter((u) => u.kind === "file").map(describeUnit);
  assert.deepEqual(whole, [
    "assets/logo.bin file binary",
    "empty.txt file empty",
    "src/lib-link.js file symlink",
    "src/old-name.js file typechange",
    "vendor/sub file gitlink",
  ]);
});

test("unit ids are stable across extracts and survive an unrelated tip change", async (t) => {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  const idsByPath = (d: Diff) => [...d.units.values()].map((u) => `${u.path} ${u.id}`);
  const first = idsByPath(await loadDiff(repo.dir, "main", "feature"));
  assert.deepEqual(idsByPath(await loadDiff(repo.dir, "main", "feature")), first);
  for (const line of first) assert.match(line, / [hfm]_[0-9a-f]{12}$/);

  writeFileSync(join(repo.dir, "README.md"), "# demo\n\nnewer intro\n");
  execFileSync("git", ["commit", "-qam", "move tip"], { cwd: repo.dir });
  const moved = idsByPath(await loadDiff(repo.dir, "main", "feature"));
  assert.deepEqual(
    first.filter((line) => !moved.includes(line)).map((line) => line.split(" ")[0]),
    ["README.md"],
  );
});

test("a missing final newline round-trips through the hunk body and projection", async (t) => {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  const d = await loadDiff(repo.dir, "main", "feature");
  const notes = [...d.textFiles.values()].find((f) => f.path === "notes.txt");
  assert.ok(notes);
  assert.deepEqual(notes.hunks[0]?.body, [
    { op: " ", text: "line one\n" },
    { op: "-", text: "line two", change: 0 },
    { op: "+", text: "line two\n", change: 1 },
    { op: "+", text: "line three", change: 2 },
  ]);
  assert.equal(
    projectFile(notes, () => true),
    "line one\nline two\nline three",
  );
  assert.equal(
    projectFile(notes, () => false),
    "line one\nline two",
  );
  assert.equal(
    projectFile(notes, (_h, c) => c < 2),
    "line one\nline two\n",
  );
});

test("projecting all lines gives the tip bytes and no lines gives the base bytes", async (t) => {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  const d: Diff = await loadDiff(repo.dir, "main", "feature");
  const seen: string[] = [];
  for (const [path, file] of d.textFiles) {
    seen.push(path);
    assert.equal(
      projectFile(file, () => true),
      gitShow(repo.dir, `feature:${path}`),
      path,
    );
    assert.equal(
      projectFile(file, () => false),
      gitShow(repo.dir, `main:${path}`),
      path,
    );
  }
  assert.deepEqual(seen, [
    "README.md",
    "notes.txt",
    "scripts/run.sh",
    "src/guard.js",
    "src/lib.js",
    "src/new-name.js",
    "src/old-name.js",
  ]);
});

test("a context line that disagrees with the base blob aborts the parse", () => {
  const a = sha("a".repeat(40));
  const b = sha("b".repeat(40));
  const input = {
    base: a,
    tip: b,
    baseTree: a,
    tipTree: b,
    rawZ: `:100644 100644 ${a} ${b} M\0f.txt\0`,
    patch: [
      "diff --git a/f.txt b/f.txt",
      `index ${a}..${b} 100644`,
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,2 +1,2 @@",
      " x",
      "-y",
      "+z",
      "",
    ].join("\n"),
  };
  assert.throws(
    () =>
      parseDiff({
        ...input,
        blobs: new Map([
          [a, "x\nWRONG\n"],
          [b, "x\nz\n"],
        ]),
      }),
    {
      name: "DiffParseError",
      message: "f.txt @@ -1,2 +1,2 @@: line 2 does not match the base blob",
    },
  );
  const ok = parseDiff({
    ...input,
    blobs: new Map([
      [a, "x\ny\n"],
      [b, "x\nz\n"],
    ]),
  });
  assert.deepEqual([...ok.units.values()].map(describeUnit), ["f.txt hunk 2"]);
});

test("unit refs parse and format as h_x and h_x:0-3,7", () => {
  const ref = parseUnitRef("h_0123456789ab:7,0-3");
  assert.deepEqual(ref, {
    unit: "h_0123456789ab",
    select: { kind: "lines", changes: [7, 0, 1, 2, 3] },
  });
  assert.ok(!("error" in ref));
  assert.equal(formatUnitRef(ref), "h_0123456789ab:0-3,7");
  const rest = parseUnitRef("m_0123456789ab~2");
  assert.deepEqual(rest, { unit: "m_0123456789ab~2", select: { kind: "rest" } });
  assert.ok(!("error" in rest));
  assert.equal(formatUnitRef(rest), "m_0123456789ab~2");
  assert.deepEqual(parseUnitRef("x_1"), { error: '"x_1" is not a unit id' });
  assert.deepEqual(parseUnitRef("h_0123456789ab:3-1"), { error: "range 3-1 runs backwards" });
});
