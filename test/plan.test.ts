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
      reason:
        'expected a unit ref string or { "unit", "narration", "diagram", "concerns", "offers" }',
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

test("a title over 72 characters is a warning that still passes", () => {
  const long = `feat: ${"x".repeat(67)}`;
  const verdict = validatePlan(
    diff,
    draft(diff, [{ message: `${long}\n\n${"body ".repeat(30)}`, units: everything(diff) }]),
  );
  assert.ok(verdict.ok);
  assert.deepEqual(verdict.warnings, [{ kind: "long-title", commit: 0, length: 73 }]);
  const fine = validatePlan(
    diff,
    draft(diff, [{ message: long.slice(0, 72), units: everything(diff) }]),
  );
  assert.ok(fine.ok);
  assert.deepEqual(fine.warnings, []);
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

test("diagrams round-trip like narration and must start with a Mermaid diagram type", () => {
  const lib = unitAt(diff, "src/lib.js", 1);
  const readme = unitAt(diff, "README.md");
  const flow = "flowchart LR\n  add --> assertNumber";
  const wire = {
    schema: PLAN_SCHEMA,
    base: diff.base,
    tip: diff.tip,
    commits: [
      {
        message: "feat: guard",
        diagram: flow,
        units: [
          { unit: `${lib}:2`, diagram: "\n%%{init: {}}%%\nsequenceDiagram\n  a->>b: x" },
          readme,
        ],
      },
      {
        message: "feat: the rest",
        narration: null,
        diagram: null,
        units: [{ unit: `${lib}:0-1`, narration: null, diagram: "  " }],
      },
    ],
    responses: [],
  };
  const parsed = parsePlanFile(wire);
  assert.ok(!Array.isArray(parsed), JSON.stringify(parsed));
  assert.deepEqual(serializePlanFile(parsed), {
    ...wire,
    commits: [wire.commits[0], { message: "feat: the rest", units: [`${lib}:0-1`] }],
  });
  assert.deepEqual(
    parsePlanFile({
      ...wire,
      commits: [
        { message: "x", diagram: "graphs TD", units: [] },
        { message: "y", diagram: 2, units: [{ unit: readme, diagram: "A --> B" }] },
      ],
    }),
    [
      {
        kind: "malformed",
        at: "$.commits[0].diagram",
        reason:
          'expected Mermaid source whose first line starts with a diagram type such as flowchart, sequenceDiagram or stateDiagram-v2, got "graphs TD"',
      },
      { kind: "malformed", at: "$.commits[1].diagram", reason: "expected a string" },
      {
        kind: "malformed",
        at: "$.commits[1].units[0]",
        reason:
          'diagram: expected Mermaid source whose first line starts with a diagram type such as flowchart, sequenceDiagram or stateDiagram-v2, got "A --> B"',
      },
    ],
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
        diagram: "stateDiagram-v2\n  [*] --> checked",
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
  assert.equal(first?.diagram, "stateDiagram-v2\n  [*] --> checked");
  assert.deepEqual(first?.refs, [
    { unit: lib, select: { kind: "lines", changes: [2] }, narration: "Just the check." },
  ]);
  assert.equal(second?.narration, undefined);
  assert.deepEqual(
    second?.refs.find((r) => r.unit === lib),
    { unit: lib, select: { kind: "lines", changes: [0, 1, 3, 4, 5, 6] }, narration: "The rest." },
  );
});

function planWith(commits: readonly unknown[], responses: readonly unknown[] = []) {
  return { ...draft(diff, []), commits, responses };
}

test("concerns get derived ids, ride on projected commits and leave plain plans byte-identical", () => {
  const lib = unitAt(diff, "src/lib.js", 1);
  const concern = { severity: "major", kind: "bug", text: "div skips non-numbers.", lines: [2] };
  const withConcerns = planWith([
    {
      message: "feat: guard div",
      concerns: [{ severity: "minor", kind: "risk", text: "This ordering hides the guard." }],
      units: [{ unit: `${lib}:2`, concerns: [concern] }],
    },
    { message: "feat: the rest", units: everything(diff) },
  ]);
  const verdict = validatePlan(diff, withConcerns);
  assert.ok(verdict.ok, JSON.stringify(!verdict.ok && verdict.issues));
  const [first, second] = verdict.plan.commits;
  assert.deepEqual(
    first?.concerns?.map(({ id: _id, ...rest }) => rest),
    [
      { severity: "minor", kind: "risk", text: "This ordering hides the guard." },
      { ...concern, unit: lib },
    ],
  );
  for (const placed of first?.concerns ?? []) assert.match(placed.id, /^k_[0-9a-f]{8}$/);
  assert.equal(second?.concerns, undefined);

  // Re-planning around the same concern keeps its id.
  const reordered = validatePlan(
    diff,
    planWith([
      {
        message: "feat: the rest",
        units: [`${lib}:0-1,3-6`, ...everything(diff).filter((u) => u !== lib)],
      },
      { message: "feat: guard div", units: [{ unit: `${lib}:2`, concerns: [concern] }] },
    ]),
  );
  assert.ok(reordered.ok);
  assert.equal(reordered.plan.commits[1]?.concerns?.[0]?.id, first?.concerns?.[1]?.id);

  // The wire form survives a round trip, and concern-free plans serialize as before.
  const parsed = parsePlanFile(withConcerns);
  assert.ok(!Array.isArray(parsed));
  assert.deepEqual(parsePlanFile(serializePlanFile(parsed)), parsed);
  const plain = planWith([{ message: "a", units: everything(diff) }]);
  const nulled = parsePlanFile(
    planWith([{ message: "a", units: everything(diff), concerns: null }]),
  );
  assert.ok(!Array.isArray(nulled));
  assert.equal(JSON.stringify(serializePlanFile(nulled)), JSON.stringify(plain));
});

test("a unit carries one concern per commit, on lines its commit takes, and lines only belong to units", () => {
  const lib = unitAt(diff, "src/lib.js", 1);
  const rest = everything(diff).filter((u) => u !== lib);
  const note = (text: string, lines?: number[]) => ({
    severity: "minor",
    kind: "naming",
    text,
    ...(lines === undefined ? {} : { lines }),
  });
  // Each slice of a hunk split across commits may carry its own concern.
  const slices = validatePlan(
    diff,
    planWith([
      { message: "a", units: [{ unit: `${lib}:0-1`, concerns: [note("one", [0])] }] },
      { message: "b", units: [{ unit: `${lib}:2-6`, concerns: [note("two", [3])] }, ...rest] },
    ]),
  );
  assert.ok(slices.ok);

  const two = validatePlan(
    diff,
    planWith([
      { message: "a", units: [`${lib}:0-1`] },
      {
        message: "b",
        units: [
          { unit: `${lib}:2-3`, concerns: [note("two", [3])] },
          { unit: `${lib}:4-6`, concerns: [note("three", [5])] },
          ...rest,
        ],
      },
    ]),
  );
  assert.deepEqual(issuesOf(two), [{ kind: "too-many-concerns", unit: lib, commit: 1, count: 2 }]);

  const elsewhere = validatePlan(
    diff,
    planWith([
      { message: "a", units: [{ unit: `${lib}:0-1`, concerns: [note("far", [5])] }] },
      { message: "b", units: [`${lib}:2-6`, ...rest] },
    ]),
  );
  assert.deepEqual(
    issuesOf(elsewhere).map((i) => i.kind),
    ["bad-concern"],
  );

  const onCommit = parsePlanFile(
    planWith([{ message: "a", concerns: [note("x", [0])], units: everything(diff) }]),
  );
  assert.deepEqual(onCommit, [
    {
      kind: "malformed",
      at: "$.commits[0].concerns",
      reason: "[0]: lines: only a concern on a unit ref has lines",
    },
  ]);
  const badSeverity = parsePlanFile(
    planWith([
      { message: "a", concerns: [{ severity: "huge", kind: "bug", text: "x" }], units: [] },
    ]),
  );
  assert.ok(Array.isArray(badSeverity));
});

test("an answered response must answer a question and point at an explanation", () => {
  const units = everything(diff);
  const base = review("c_q", "c_change");
  const asked: Review = {
    ...base,
    comments: base.comments.map((c) => (c.id === "c_q" ? { ...c, kind: "question" } : c)),
  };
  const answer = (comment: string, at: unknown, status = "answered") => ({
    comment,
    status,
    note: "because",
    ...(at === undefined ? {} : { at }),
  });
  const verdictOf = (commit: object, responses: unknown[]) =>
    validatePlan(diff, planWith([{ message: "a", ...commit, units }], responses), {
      lastReview: asked,
    });
  const reasons = (responses: unknown[], commit: object = { narration: "Here is why." }) =>
    issuesOf(verdictOf(commit, responses)).map((i) =>
      i.kind === "bad-answer" ? i.reason : i.kind,
    );
  const change = answer("c_change", undefined, "deferred");

  const ok = verdictOf({ narration: "Here is why." }, [answer("c_q", { commit: 1 }), change]);
  assert.ok(ok.ok);
  assert.equal(ok.plan.file.responses[0]?.at?.commit, 1);

  assert.deepEqual(reasons([answer("c_q", undefined), change]), [
    'an answer needs "at" naming the commit that explains it',
  ]);
  assert.deepEqual(reasons([answer("c_q", { commit: 2 }), change]), [
    "at.commit 2 is not a commit of this plan",
  ]);
  assert.deepEqual(reasons([answer("c_q", { commit: 1 }), change], {}), [
    "commit 1 has no narration or diagram to point at",
  ]);
  assert.deepEqual(
    reasons([
      answer("c_q", { commit: 1, unit: "h_ffffffffffff" }),
      answer("c_change", { commit: 1 }),
    ]),
    [
      "commit 1 does not take h_ffffffffffff",
      "answered is only for questions; use addressed, declined or deferred",
    ],
  );

  const addressed = verdictOf({}, [answer("c_q", undefined, "addressed"), change]);
  assert.ok(addressed.ok);
  assert.deepEqual(addressed.warnings, [{ kind: "question-addressed", comment: "c_q" }]);
});

test("a section rides into the projected commit, round-trips, and stays out of plans without one", () => {
  const lib = unitAt(diff, "src/lib.js", 1);
  const sectioned = planWith([
    { message: "feat: guard div", section: "story", units: [`${lib}:2`] },
    { message: "feat: the rest", section: "details", units: everything(diff) },
  ]);
  const verdict = validatePlan(diff, sectioned);
  assert.ok(verdict.ok, JSON.stringify(!verdict.ok && verdict.issues));
  assert.deepEqual(
    verdict.plan.commits.map((c) => c.section),
    ["story", "details"],
  );
  const parsed = parsePlanFile(sectioned);
  assert.ok(!Array.isArray(parsed));
  assert.equal(JSON.stringify(serializePlanFile(parsed)), JSON.stringify(sectioned));

  const plain = planWith([{ message: "a", units: everything(diff) }]);
  const unsectioned = parsePlanFile(
    planWith([{ message: "a", section: null, units: everything(diff) }]),
  );
  assert.ok(!Array.isArray(unsectioned));
  assert.equal(JSON.stringify(serializePlanFile(unsectioned)), JSON.stringify(plain));
});

test("an unknown section is malformed and names the allowed ones", () => {
  const issues = issuesOf(
    validatePlan(diff, planWith([{ message: "a", section: "prologue", units: everything(diff) }])),
  );
  assert.deepEqual(issues, [
    {
      kind: "malformed",
      at: "$.commits[0].section",
      reason: "expected one of story, steps, details, wiring",
    },
  ]);
});

test("offers get ids from their place and label, ride on projected commits and keep plain hashes", () => {
  const lib = unitAt(diff, "src/lib.js", 1);
  const rest = everything(diff).filter((u) => u !== lib);
  const machine = { kind: "state-machine", label: "Draw div as a state machine" };
  const flow = { kind: "sequence", label: "Draw how add reaches the guard" };
  const offered = planWith([
    { message: "feat: guard div", units: [{ unit: lib, offers: [machine] }] },
    { message: "feat: the rest", offers: [flow], units: rest },
  ]);
  const verdict = validatePlan(diff, offered);
  assert.ok(verdict.ok, JSON.stringify(!verdict.ok && verdict.issues));
  const [first, second] = verdict.plan.commits;
  const unitOffer = first?.offers?.[0];
  const commitOffer = second?.offers?.[0];
  assert.deepEqual({ ...unitOffer, id: "" }, { ...machine, unit: lib, id: "" });
  assert.deepEqual({ ...commitOffer, id: "" }, { ...flow, id: "" });
  assert.match(unitOffer?.id ?? "", /^o_[0-9a-f]{8}$/);
  assert.match(commitOffer?.id ?? "", /^o_[0-9a-f]{8}$/);

  // Re-planning in another order with the same labels at the same places keeps both ids.
  const reordered = validatePlan(
    diff,
    planWith([
      { message: "feat: everything else", offers: [flow], units: rest },
      { message: "feat: guard div last", units: [{ unit: lib, offers: [machine] }] },
    ]),
  );
  assert.ok(reordered.ok);
  assert.equal(reordered.plan.commits[0]?.offers?.[0]?.id, commitOffer?.id);
  assert.equal(reordered.plan.commits[1]?.offers?.[0]?.id, unitOffer?.id);

  // The wire form round-trips, and plans without offers serialize and hash as before.
  const parsed = parsePlanFile(offered);
  assert.ok(!Array.isArray(parsed));
  assert.deepEqual(parsePlanFile(serializePlanFile(parsed)), parsed);
  const plain = planWith([{ message: "a", units: everything(diff) }]);
  const empty = parsePlanFile(planWith([{ message: "a", offers: [], units: everything(diff) }]));
  const plainFile = parsePlanFile(plain);
  assert.ok(!Array.isArray(empty) && !Array.isArray(plainFile));
  assert.equal(JSON.stringify(serializePlanFile(empty)), JSON.stringify(plain));
  assert.equal(planHash(empty), planHash(plainFile));

  assert.deepEqual(
    parsePlanFile(planWith([{ message: "a", offers: [{ kind: "chart", label: "x" }], units: [] }])),
    [
      {
        kind: "malformed",
        at: "$.commits[0].offers",
        reason: "[0]: kind: expected one of state-machine, sequence, diagram",
      },
    ],
  );
  assert.deepEqual(
    parsePlanFile(
      planWith([{ message: "a", units: [{ unit: lib, offers: [{ kind: "diagram" }] }] }]),
    ),
    [
      {
        kind: "malformed",
        at: "$.commits[0].units[0]",
        reason:
          'offers: [0]: label: expected what to draw, like "Draw UploadButton as a state machine"',
      },
    ],
  );
});

test("check allows one offer per commit and three per plan", () => {
  const units = everything(diff);
  const offer = (label: string) => ({ kind: "diagram", label });
  const [u0 = "", u1 = "", u2 = "", ...others] = units;
  assert.ok(others.length > 0, "the fixture has at least four units");

  const two = validatePlan(
    diff,
    planWith([
      { message: "a", offers: [offer("one")], units: [{ unit: u0, offers: [offer("two")] }] },
      { message: "b", units: units.slice(1) },
    ]),
  );
  assert.deepEqual(issuesOf(two), [{ kind: "too-many-offers", commit: 0, count: 2 }]);

  const four = validatePlan(
    diff,
    planWith([
      { message: "a", offers: [offer("one")], units: [u0] },
      { message: "b", offers: [offer("two")], units: [u1] },
      { message: "c", offers: [offer("three")], units: [u2] },
      { message: "d", offers: [offer("four")], units: others },
    ]),
  );
  assert.deepEqual(issuesOf(four), [{ kind: "too-many-offers", commit: null, count: 4 }]);

  const three = validatePlan(
    diff,
    planWith([
      { message: "a", offers: [offer("one")], units: [u0] },
      { message: "b", offers: [offer("two")], units: [u1] },
      { message: "c", offers: [offer("three")], units: [u2, ...others] },
    ]),
  );
  assert.ok(three.ok, JSON.stringify(!three.ok && three.issues));

  const repeated = validatePlan(
    diff,
    planWith([
      { message: "a", offers: [offer("same")], units: [u0] },
      { message: "b", offers: [offer("same")], units: units.slice(1) },
    ]),
  );
  assert.deepEqual(
    issuesOf(repeated).map((i) => i.kind),
    ["bad-offer"],
  );
});

test("sections out of top-down order are a warning that names the commit", () => {
  const lib = unitAt(diff, "src/lib.js", 1);
  const backwards = validatePlan(
    diff,
    planWith([
      { message: "feat: the guard", section: "details", units: [`${lib}:2`] },
      { message: "feat: the rest", section: "story", units: everything(diff) },
    ]),
  );
  assert.ok(backwards.ok);
  assert.deepEqual(backwards.warnings, [
    { kind: "section-order", commit: 1, section: "story", after: "details" },
  ]);

  const inOrder = validatePlan(
    diff,
    planWith([
      { message: "feat: guard div", section: "story", units: [`${lib}:2`] },
      { message: "feat: the rest", units: everything(diff) },
    ]),
  );
  assert.ok(inOrder.ok);
  assert.deepEqual(inOrder.warnings, []);
});
