import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { loadDiff } from "../src/git.ts";
import {
  isCommentId,
  isPlanVersion,
  PLAN_SCHEMA,
  parsePlanFile,
  planHash,
  serializePlanFile,
  validatePlan,
} from "../src/plan.ts";
import type { Diff, Review, UnitId } from "../src/types.ts";
import { makeFixtureRepo } from "./fixture-repo.ts";

const repo = makeFixtureRepo();
let diff: Diff;
before(async () => {
  diff = await loadDiff(repo.dir, "main", "feature");
});
after(repo.cleanup);

function unitAt(d: Diff, path: string, n = 0): UnitId {
  const id = [...d.units.values()].filter((u) => u.path === path)[n]?.id;
  assert.ok(id, `unit ${n} of ${path}`);
  return id;
}

function draft(d: Diff, commits: readonly { message: string; units: string[] }[], extra = {}) {
  return { schema: PLAN_SCHEMA, base: d.base, tip: d.tip, commits, responses: [], ...extra };
}

function everything(d: Diff): string[] {
  return [...d.units.keys()];
}

function issuesOf(verdict: ReturnType<typeof validatePlan>) {
  assert.equal(verdict.ok, false, "expected the plan to be rejected");
  return verdict.ok ? [] : verdict.issues;
}

test("a plan taking every unit once projects each commit's tree changes", () => {
  const lib = unitAt(diff, "src/lib.js", 1);
  const verdict = validatePlan(
    diff,
    draft(diff, [
      { message: "feat: guard div", units: [`${lib}:2`] },
      { message: "feat: the rest", units: everything(diff) },
    ]),
  );
  assert.ok(verdict.ok);
  assert.deepEqual(verdict.warnings, []);
  const [first, second] = verdict.plan.commits;
  assert.deepEqual(first?.changes, [
    {
      path: "src/lib.js",
      op: "write",
      mode: "100644",
      bytes: [
        "export function add(a, b) {",
        "  return a + b;",
        "}",
        "",
        "export function sub(a, b) {",
        "  return a - b;",
        "}",
        "",
        "export function mul(a, b) {",
        "  return a * b;",
        "}",
        "",
        "export function div(a, b) {",
        "  if (b === 0) throw new RangeError('division by zero');",
        "  return a / b;",
        "}",
        "",
      ].join("\n"),
    },
  ]);
  assert.deepEqual(
    second?.refs.find((r) => r.unit === lib),
    { unit: lib, select: { kind: "lines", changes: [0, 1, 3, 4, 5, 6] } },
  );
  assert.deepEqual(
    second?.changes.map((c) => `${c.op} ${c.path}`),
    [
      "write README.md",
      "link assets/logo.bin",
      "write notes.txt",
      "write scripts/run.sh",
      "write src/guard.js",
      "write src/lib.js",
      "write src/new-name.js",
      "delete src/old-name.js",
    ],
  );
});

test("malformed: every bad field is reported with its JSON path", () => {
  const issues = issuesOf(
    validatePlan(diff, {
      schema: "nope",
      base: "abc",
      tip: diff.tip,
      commits: [{ message: 3, units: ["h_zz", 4] }, "x"],
      responses: {},
    }),
  );
  assert.deepEqual(issues, [
    { kind: "malformed", at: "$.schema", reason: 'expected "follow-me/plan@1"' },
    { kind: "malformed", at: "$.base", reason: "expected a full commit sha" },
    { kind: "malformed", at: "$.commits[0].message", reason: "expected a string" },
    { kind: "malformed", at: "$.commits[0].units[0]", reason: '"h_zz" is not a unit id' },
    {
      kind: "malformed",
      at: "$.commits[0].units[1]",
      reason: 'expected a unit ref string or { "unit", "narration" }',
    },
    { kind: "malformed", at: "$.commits[1]", reason: "expected an object" },
    { kind: "malformed", at: "$.responses", reason: "expected an array" },
  ]);
});

test("stale: a plan for another tip", () => {
  const issues = issuesOf(
    validatePlan(diff, {
      ...draft(diff, [{ message: "x", units: everything(diff) }]),
      tip: "f".repeat(40),
    }),
  );
  assert.deepEqual(issues, [{ kind: "stale", planTip: "f".repeat(40), sessionTip: repo.branch }]);
});

test("empty-message and empty-commit", () => {
  const issues = issuesOf(
    validatePlan(
      diff,
      draft(diff, [
        { message: "  \n", units: everything(diff) },
        { message: "chore: nothing", units: [] },
      ]),
    ),
  );
  assert.deepEqual(issues, [
    { kind: "empty-message", commit: 0 },
    { kind: "empty-commit", commit: 1 },
  ]);
});

test("unknown-unit", () => {
  const issues = issuesOf(
    validatePlan(
      diff,
      draft(diff, [{ message: "x", units: [...everything(diff), "h_000000000000:1"] }]),
    ),
  );
  assert.deepEqual(issues, [{ kind: "unknown-unit", commit: 0, ref: "h_000000000000:1" }]);
});

test("bad-selection: out of range, repeated, split whole-file unit, nothing left", () => {
  const lib = unitAt(diff, "src/lib.js");
  const bin = unitAt(diff, "assets/logo.bin");
  const readme = unitAt(diff, "README.md");
  const issues = issuesOf(
    validatePlan(
      diff,
      draft(diff, [
        { message: "a", units: everything(diff).filter((id) => id !== readme) },
        { message: "b", units: [`${lib}:9`, `${lib}:1,1`, `${bin}:0`, `${readme}:0-5`] },
        { message: "c", units: [readme] },
      ]),
    ),
  );
  assert.deepEqual(issues, [
    { kind: "bad-selection", commit: 1, unit: lib, reason: "changes 9 are outside [0, 4)" },
    { kind: "bad-selection", commit: 1, unit: lib, reason: "changes 1 are listed twice" },
    {
      kind: "bad-selection",
      commit: 1,
      unit: bin,
      reason: "whole-file and mode units are taken whole",
    },
    {
      kind: "bad-selection",
      commit: 2,
      unit: readme,
      reason: "every change line is already claimed by explicit selections",
    },
  ]);
});

test("duplicate: overlapping explicit lines and two bare refs", () => {
  const lib = unitAt(diff, "src/lib.js");
  const bin = unitAt(diff, "assets/logo.bin");
  const issues = issuesOf(
    validatePlan(
      diff,
      draft(diff, [
        { message: "a", units: everything(diff) },
        { message: "b", units: [`${lib}:0-1`] },
        { message: "c", units: [`${lib}:1-2`, bin] },
      ]),
    ),
  );
  assert.deepEqual(issues, [
    { kind: "duplicate", unit: lib, changes: [1], commits: [1, 2] },
    { kind: "duplicate", unit: bin, changes: [], commits: [0, 2] },
  ]);
});

test("unassigned: every change line and whole unit left out", () => {
  const readme = unitAt(diff, "README.md");
  const lib = unitAt(diff, "src/lib.js");
  const bin = unitAt(diff, "assets/logo.bin");
  const units = everything(diff).filter((id) => id !== readme && id !== bin && id !== lib);
  const issues = issuesOf(
    validatePlan(diff, draft(diff, [{ message: "a", units: [...units, `${lib}:0,3`] }])),
  );
  assert.deepEqual(issues, [
    { kind: "unassigned", unit: readme, path: "README.md", changes: [0, 1, 2, 3, 4, 5] },
    { kind: "unassigned", unit: bin, path: "assets/logo.bin", changes: [] },
    { kind: "unassigned", unit: lib, path: "src/lib.js", changes: [1, 2] },
  ]);
});

test("path-conflict: a directory added before the file it replaces is deleted", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "follow-me-conflict-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      cwd: dir,
      encoding: "utf8",
    });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "lib"), "old\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  git("checkout", "-qb", "feature");
  rmSync(join(dir, "lib"));
  mkdirSync(join(dir, "lib"));
  writeFileSync(join(dir, "lib/index.js"), "new\n");
  git("add", "-A");
  git("commit", "-qm", "tip");
  const d = await loadDiff(dir, "main", "feature");
  const added = unitAt(d, "lib/index.js");
  const removed = unitAt(d, "lib");

  const issues = issuesOf(
    validatePlan(
      d,
      draft(d, [
        { message: "add the directory", units: [added] },
        { message: "remove the file", units: [removed] },
      ]),
    ),
  );
  assert.deepEqual(issues, [
    { kind: "path-conflict", commit: 0, file: "lib", under: "lib/index.js" },
  ]);
  const swapped = validatePlan(
    d,
    draft(d, [
      { message: "remove the file", units: [removed] },
      { message: "add the directory", units: [added] },
    ]),
  );
  assert.equal(swapped.ok, true);
});

function review(...ids: string[]): Review {
  const version = 1;
  assert.ok(isPlanVersion(version));
  return {
    schema: "follow-me/review@1",
    mode: "split",
    planVersion: version,
    planHash: "0".repeat(64),
    endedAt: "2026-10-19T00:00:00.000Z",
    comments: ids.map((id) => {
      assert.ok(isCommentId(id));
      return {
        id,
        anchor: { kind: "plan" },
        context: { commitMessage: "", path: null },
        body: `about ${id}`,
        createdAt: "2026-10-19T00:00:00.000Z",
      };
    }),
  };
}

test("unknown-response, and unanswered comments are warnings that still pass", () => {
  const units = everything(diff);
  const responses = [{ comment: "c_1", status: "addressed", note: "split it" }];
  const issues = issuesOf(
    validatePlan(diff, draft(diff, [{ message: "a", units }], { responses })),
  );
  assert.deepEqual(issues, [{ kind: "unknown-response", comment: "c_1" }]);

  const verdict = validatePlan(diff, draft(diff, [{ message: "a", units }], { responses }), {
    lastReview: review("c_1", "c_2"),
  });
  assert.ok(verdict.ok);
  assert.deepEqual(verdict.warnings, [{ kind: "unanswered", comment: "c_2", review: 1 }]);
});

test("final-mismatch: a diff whose tip disagrees with its hunks", () => {
  const textFiles = new Map(
    [...diff.textFiles].map(([path, file]) => [
      path,
      path === "README.md" && file.tip
        ? { ...file, tip: { ...file.tip, bytes: "tampered\n" } }
        : file,
    ]),
  );
  const readme = [...diff.textFiles.values()].find((f) => f.path === "README.md");
  const issues = issuesOf(
    validatePlan({ ...diff, textFiles }, draft(diff, [{ message: "a", units: everything(diff) }])),
  );
  assert.deepEqual(issues, [
    {
      kind: "final-mismatch",
      path: "README.md",
      expected: readme?.tip?.entry,
      got: "100644 with 36 bytes",
    },
  ]);
});

test("narration round-trips, using the object form only where a unit carries it", () => {
  const lib = unitAt(diff, "src/lib.js", 1);
  const readme = unitAt(diff, "README.md");
  const wire = {
    schema: PLAN_SCHEMA,
    base: diff.base,
    tip: diff.tip,
    commits: [
      {
        message: "feat: guard div",
        narration: "Division by zero bites first, so I guard it before anything else.",
        units: [{ unit: `${lib}:2`, narration: "One line, the check itself." }, readme],
      },
      { message: "feat: the rest", units: [`${lib}:0-1`] },
    ],
    responses: [],
  };
  const parsed = parsePlanFile({
    ...wire,
    commits: [...wire.commits, { message: "chore: blank", narration: "  ", units: [] }],
  });
  assert.ok(!Array.isArray(parsed), JSON.stringify(parsed));
  assert.deepEqual(serializePlanFile(parsed), {
    ...wire,
    commits: [...wire.commits, { message: "chore: blank", units: [] }],
  });
  const reparsed = parsePlanFile(serializePlanFile(parsed));
  assert.ok(!Array.isArray(reparsed));
  assert.equal(planHash(reparsed), planHash(parsed));
  assert.deepEqual(
    parsePlanFile({ ...wire, commits: [{ message: "x", narration: 3, units: [] }] }),
    [{ kind: "malformed", at: "$.commits[0].narration", reason: "expected a string" }],
  );
});

test("validation carries commit and unit narration into the projected commits", () => {
  const lib = unitAt(diff, "src/lib.js", 1);
  const verdict = validatePlan(diff, {
    schema: PLAN_SCHEMA,
    base: diff.base,
    tip: diff.tip,
    commits: [
      {
        message: "feat: guard div",
        narration: "I guard division first.",
        units: [{ unit: `${lib}:2`, narration: "Just the check." }],
      },
      {
        message: "feat: the rest",
        units: everything(diff).map((u) => (u === lib ? { unit: u, narration: "The rest." } : u)),
      },
    ],
    responses: [],
  });
  assert.ok(verdict.ok);
  const [first, second] = verdict.plan.commits;
  assert.equal(first?.narration, "I guard division first.");
  assert.deepEqual(first?.refs, [
    { unit: lib, select: { kind: "lines", changes: [2] }, narration: "Just the check." },
  ]);
  assert.equal(second?.narration, undefined);
  assert.deepEqual(
    second?.refs.find((r) => r.unit === lib),
    { unit: lib, select: { kind: "lines", changes: [0, 1, 3, 4, 5, 6] }, narration: "The rest." },
  );
});
