import assert from "node:assert/strict";
import { test } from "node:test";
import type { BodyRow } from "../ui/selection.js";
import type { Comment, Entry, LogEvent, Reply, TimelineState } from "../ui/timeline.js";
import {
  anchorText,
  atBottom,
  beatFor,
  chipText,
  concernLine,
  dividerText,
  entriesHere,
  isHere,
  locate,
  quoteOf,
  snippet,
  timelineOf,
  unreadAfter,
} from "../ui/timeline.js";

const body: BodyRow[] = [
  { op: " ", text: "function div(a, b) {\n" },
  { op: "+", text: "  if (b === 0) throw new RangeError('zero');\n", change: 0 },
  { op: " ", text: "  return a / b;\n" },
  { op: "+", text: "  // more\n", change: 1 },
];

const comment = (id: string, over: Partial<Comment> = {}): Comment => ({
  id,
  anchor: { kind: "hunk", unit: "h_a", commit: 1, changes: [0], offsets: [1] },
  body: `body ${id}`,
  createdAt: "2026-01-01T10:00:00Z",
  context: { commitMessage: "m", path: "src/lib.js", lines: ["a", "b", "c", "d"] },
  ...over,
});
const reply = (id: string, author: string, at: string): Reply => ({
  id,
  author,
  body: `reply ${id}`,
  createdAt: at,
});

const state = (over: Partial<TimelineState> = {}): TimelineState => ({
  comments: [],
  previous: null,
  decisions: {},
  resolved: [],
  version: 1,
  units: [{ kind: "hunk", id: "h_a", path: "src/lib.js", body }],
  commits: [
    { index: 0, refs: [] },
    {
      index: 1,
      refs: [{ unit: "h_a", select: { kind: "lines", changes: [0, 1] } }],
      concerns: [
        { id: "k_1", severity: "major", kind: "bug", text: "unguarded", lines: [0], unit: "h_a" },
      ],
    },
  ],
  ...over,
});

const ids = (entries: readonly Entry[]) => entries.map((e) => e.id);

test("the log gives the order: comment, reply, decision, resolve, then the end", () => {
  const c = comment("c_1", { replies: [reply("r_1", "agent", "2026-01-01T10:05:00Z")] });
  const events: LogEvent[] = [
    { type: "comment", seq: 1, comment: c },
    {
      type: "reply",
      seq: 2,
      commentId: "c_1",
      reply: reply("r_1", "agent", "2026-01-01T10:05:00Z"),
    },
    { type: "concern", seq: 3, concernId: "k_1", decision: "kept", severity: "major" },
    { type: "resolved", seq: 4, commentId: "c_1", resolved: true },
    { type: "ended", seq: 5, review: "r" },
  ];
  const entries = timelineOf(state({ comments: [c] }), events);
  assert.deepEqual(ids(entries), ["c:c_1", "r:r_1", "k:k_1:3", "x:c_1:4", "ended"]);
});

test("events arriving out of order are read by seq, and a replayed one adds nothing", () => {
  const c = comment("c_1");
  const first: LogEvent = { type: "comment", seq: 1, comment: c };
  const entries = timelineOf(state({ comments: [c] }), [
    { type: "ended", seq: 3, review: "r" },
    first,
    first,
  ]);
  assert.deepEqual(ids(entries), ["c:c_1", "ended"]);
});

test("after a restart the saved state is ordered by its timestamps", () => {
  const early = comment("c_1", {
    createdAt: "2026-01-01T09:00:00Z",
    replies: [reply("r_2", "agent", "2026-01-01T11:00:00Z")],
  });
  const late = comment("c_2", {
    createdAt: "2026-01-01T10:00:00Z",
    replies: [reply("r_1", "reviewer", "2026-01-01T12:00:00Z")],
  });
  const entries = timelineOf(state({ comments: [late, early] }), []);
  assert.deepEqual(ids(entries), ["c:c_1", "c:c_2", "r:r_2", "r:r_1"]);
});

test("a stamped decision sits by its time, an unstamped one and a resolve go last", () => {
  const c = comment("c_1", { createdAt: "2026-01-01T09:00:00Z" });
  const d = comment("c_2", { createdAt: "2026-01-01T11:00:00Z" });
  const entries = timelineOf(
    state({
      comments: [c, d],
      decisions: {
        k_1: { concern: "k_1", decision: "kept", decidedAt: "2026-01-01T10:00:00Z" },
        k_2: { concern: "k_2", decision: "dismissed" },
      },
      resolved: ["c_1"],
    }),
    [],
  );
  assert.deepEqual(ids(entries), ["c:c_1", "k:k_1", "c:c_2", "k:k_2", "x:c_1"]);
});

test("an agent-started comment is an entry from the agent, a reviewer one from you", () => {
  const entries = timelineOf(
    state({ comments: [comment("c_1", { author: "agent" }), comment("c_2")] }),
    [],
  );
  assert.deepEqual(
    entries.map((e) => e.kind === "comment" && e.from),
    ["agent", "you"],
  );
});

test("a deleted comment leaves the timeline, its replies with it", () => {
  const c = comment("c_1");
  const events: LogEvent[] = [
    { type: "comment", seq: 1, comment: c },
    { type: "reply", seq: 2, commentId: "c_1", reply: reply("r_1", "agent", "t") },
    { type: "comment-deleted", seq: 3, id: "c_1" },
  ];
  assert.deepEqual(timelineOf(state(), events), []);
});

test("a version event is a divider that counts the answers, followed by the answer cards", () => {
  const asked = comment("c_1", { kind: "question" });
  const previous = {
    version: 1,
    comments: [asked, comment("c_2", { kind: "question" })],
    responses: [{ comment: "c_1", status: "answered", note: "because" }],
  };
  const events: LogEvent[] = [
    { type: "comment", seq: 1, comment: asked },
    { type: "comment", seq: 2, comment: previous.comments[1] },
    { type: "version", seq: 3, version: 2, hash: "h" },
  ];
  const entries = timelineOf(state({ version: 2, previous }), events);
  assert.deepEqual(ids(entries), ["c:c_1", "c:c_2", "v:2", "a:c_1"]);
  const divider = entries.find((e) => e.kind === "version");
  assert.ok(divider?.kind === "version");
  assert.equal(dividerText(divider), "Plan v2 opened · answers 1 of 2 questions");
});

test("without a version event the divider is made from the previous version's comments", () => {
  const old = comment("c_1", { kind: "question", createdAt: "2026-01-01T09:00:00Z" });
  const now = comment("c_3", { createdAt: "2026-01-02T09:00:00Z" });
  const previous = { version: 1, comments: [old], responses: [] };
  const entries = timelineOf(state({ version: 2, previous, comments: [now] }), []);
  assert.deepEqual(ids(entries), ["c:c_1", "v:2", "c:c_3"]);
});

test("a divider for a version other than this one has no counts", () => {
  const entries = timelineOf(state({ version: 3 }), [{ type: "version", seq: 1, version: 2 }]);
  const divider = entries[0];
  assert.ok(divider?.kind === "version");
  assert.equal(dividerText(divider), "Plan v2 opened");
});

test("a decision names the concern it was about, or says it is an unknown one", () => {
  const [kept] = timelineOf(state(), [
    { type: "concern", seq: 1, concernId: "k_1", decision: "kept", severity: "blocker" },
  ]);
  const [lost] = timelineOf(state(), [
    { type: "concern", seq: 1, concernId: "k_9", decision: "dismissed" },
  ]);
  assert.ok(kept?.kind === "concern" && lost?.kind === "concern");
  assert.equal(
    concernLine(kept, { h_a: "src/lib.js" }),
    "You kept the agent's concern, blocker bug, on src/lib.js",
  );
  assert.equal(concernLine(lost, {}), "You dismissed an agent concern");
});

test("a comment on this plan is located by its offsets, and gone code is stale", () => {
  const [entry] = timelineOf(state({ comments: [comment("c_1")] }), []);
  assert.ok(entry);
  assert.deepEqual(locate(state({ comments: [comment("c_1")] }), entry), {
    stale: false,
    at: { commit: 1, unit: "h_a", rows: [1] },
  });
  const gone = state({ comments: [comment("c_1")], units: [] });
  assert.deepEqual(locate(gone, entry), { stale: true });
  const noCommit = comment("c_2", { anchor: { kind: "message", commit: 9 } });
  const [other] = timelineOf(state({ comments: [noCommit] }), []);
  assert.ok(other);
  assert.deepEqual(locate(state({ comments: [noCommit] }), other), { stale: true });
});

test("a whole-plan comment points nowhere, and a hunk comment without offsets uses its changes", () => {
  const plan = comment("c_1", { anchor: { kind: "plan" } });
  const old = comment("c_2", { anchor: { kind: "hunk", unit: "h_a", commit: 1, changes: [1] } });
  const s = state({ comments: [plan, old] });
  const [a, b] = timelineOf(s, []);
  assert.ok(a && b);
  assert.deepEqual(locate(s, a), { stale: false, at: null });
  assert.deepEqual(locate(s, b), { stale: false, at: { commit: 1, unit: "h_a", rows: [3] } });
});

test("a question from the previous plan is located where its answer says the code now lives", () => {
  const asked = comment("c_1", {
    kind: "question",
    anchor: { kind: "hunk", unit: "h_a", commit: 5, changes: [0] },
  });
  const previous = { version: 1, comments: [asked], responses: [] };
  const s = state({ version: 2, previous });
  const entry = timelineOf(s, []).find((e) => e.kind === "comment");
  assert.ok(entry);
  assert.deepEqual(locate(s, entry), { stale: false, at: { commit: 1, unit: "h_a", rows: [1] } });
});

test("a concern is located by the rows it pins", () => {
  const entry = timelineOf(state(), [
    { type: "concern", seq: 1, concernId: "k_1", decision: "kept" },
  ])[0];
  assert.ok(entry);
  assert.deepEqual(locate(state(), entry), {
    stale: false,
    at: { commit: 1, unit: "h_a", rows: [1] },
  });
});

test("a chunk holds the entries whose rows fall in its span, and counts threads", () => {
  const onChunk = comment("c_1");
  const aboveChunk = comment("c_2", {
    anchor: { kind: "hunk", unit: "h_a", commit: 1, changes: [], offsets: [0] },
  });
  const s = state({
    comments: [onChunk, aboveChunk],
  });
  const entries = timelineOf(s, [
    {
      type: "reply",
      seq: 1,
      commentId: "c_1",
      reply: reply("r_1", "agent", "2026-01-01T10:05:00Z"),
    },
  ]);
  const here = entriesHere(s, entries, { commit: 1, unit: "h_a", rows: [1, 3] });
  assert.equal(here.threads, 1);
  assert.deepEqual([...here.ids].sort(), ["c:c_1", "r:r_1"]);
  assert.equal(entriesHere(s, entries, { commit: 1 }).threads, 2);
  assert.equal(entriesHere(s, entries, { commit: 0 }).threads, 0);
});

test("a place is here only on the same commit and unit", () => {
  const at = { stale: false as const, at: { commit: 1, unit: "h_a", rows: [1] } };
  assert.equal(isHere(at, { commit: 1, unit: "h_b" }), false);
  assert.equal(isHere(at, { commit: 1, unit: "h_a", rows: [] }), true);
  assert.equal(isHere(at, { commit: 1, unit: null }), true);
  assert.equal(isHere({ stale: true }, { commit: 1 }), false);
});

test("playback must reach the chunk that shows one of the rows, and only then", () => {
  const beats = [
    { kind: "intro", commit: 1 },
    { kind: "chunk", commit: 1, unit: "h_a", lines: [1] },
    { kind: "chunk", commit: 1, unit: "h_a", lines: [3] },
  ];
  assert.equal(beatFor(beats, { commit: 1, unit: "h_a", rows: [2, 3] }), 2);
  assert.equal(beatFor(beats, { commit: 1, unit: "h_a", rows: [2] }), null);
  assert.equal(beatFor(beats, { commit: 1, unit: "h_a", rows: [] }), null);
  assert.equal(beatFor(beats, { commit: 1, unit: null, rows: [1] }), null);
});

test("unread counts the agent's words after the last entry read", () => {
  const a = comment("c_1");
  const s = state({
    comments: [a, comment("c_2", { author: "agent" })],
  });
  const entries = timelineOf(s, [
    { type: "comment", seq: 1, comment: a },
    { type: "reply", seq: 2, commentId: "c_1", reply: reply("r_1", "agent", "t1") },
    { type: "reply", seq: 3, commentId: "c_1", reply: reply("r_2", "reviewer", "t2") },
    { type: "comment", seq: 4, comment: comment("c_2", { author: "agent" }) },
  ]);
  assert.equal(unreadAfter(entries, null), 2);
  assert.equal(unreadAfter(entries, "r:r_1"), 1);
  assert.equal(unreadAfter(entries, "c:c_2"), 0);
});

test("the timeline counts as at the bottom within a few pixels", () => {
  assert.equal(atBottom({ scrollTop: 476, clientHeight: 500, scrollHeight: 1000 }), true);
  assert.equal(atBottom({ scrollTop: 400, clientHeight: 500, scrollHeight: 1000 }), false);
  assert.equal(atBottom({ scrollTop: 0, clientHeight: 500, scrollHeight: 400 }), true);
});

test("a quote shows three rows and says how many more there are", () => {
  assert.deepEqual(quoteOf(["a", "b", "c", "d", "e"]), { shown: ["a", "b", "c"], more: 2 });
  assert.deepEqual(quoteOf(["a"]), { shown: ["a"], more: 0 });
});

test("an anchor reads as file, rows and commit, with the version for an earlier plan", () => {
  const c = comment("c_1");
  const how = { rows: "lines 17-18", whole: "Whole plan", version: null };
  assert.equal(anchorText(c, how), "src/lib.js · lines 17-18 · commit 2");
  assert.equal(anchorText(c, { ...how, version: 1 }), "src/lib.js · lines 17-18 · commit 2 (v1)");
  assert.equal(anchorText(comment("c_2", { anchor: { kind: "plan" } }), how), "Whole plan");
  assert.equal(
    anchorText(comment("c_3", { anchor: { kind: "message", commit: 0 } }), how),
    "commit message · commit 1",
  );
});

test("a chip names the kind, the replies and whether the question is answered or resolved", () => {
  const how = { walk: false, resolved: false };
  assert.equal(chipText(comment("c_1"), how), "Change request");
  assert.equal(chipText(comment("c_1"), { walk: true, resolved: false }), "Code comment");
  const asked = comment("c_1", { kind: "question" });
  assert.equal(chipText(asked, how), "Question");
  const answered = {
    ...asked,
    replies: [reply("r_1", "agent", "t"), reply("r_2", "reviewer", "t")],
  };
  assert.equal(chipText(answered, how), "Question · 2 replies · answered");
  assert.equal(chipText(answered, { ...how, resolved: true }), "Question · 2 replies · resolved");
  assert.equal(
    chipText({ ...asked, replies: [reply("r_1", "reviewer", "t")] }, how),
    "Question · 1 reply",
  );
  assert.equal(chipText(comment("c_2", { author: "agent" }), how), "Agent note");
});

test("a snippet is the first line, cut with an ellipsis when it is long", () => {
  assert.equal(snippet("why?\nmore"), "why?");
  assert.equal(snippet("x".repeat(80), 10), "xxxxxxxxx…");
  assert.equal(snippet("  padded  "), "padded");
});
