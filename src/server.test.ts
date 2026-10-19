import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { ReviewState } from "./server.ts";
import { loadDraftComments, serveReview } from "./server.ts";
import type { Review } from "./types.ts";

const HUNK_A = "h_aaaaaaaaaaaa";
const HUNK_B = "h_bbbbbbbbbbbb";
const FILE_C = "f_cccccccccccc";

// JSON.parse is the only brand-free way to build branded literals without a cast.
function twoCommitState(comments: readonly unknown[] = []): ReviewState {
  return JSON.parse(
    JSON.stringify({
      mode: "split",
      anchor: {
        schema: "follow-me/session@1",
        branch: "feature",
        baseRef: "main",
        base: "1".repeat(40),
        tip: "2".repeat(40),
        tipTree: "3".repeat(40),
      },
      version: 3,
      planHash: "hash-of-v3",
      commits: [
        {
          index: 0,
          message: "add parser",
          refs: [
            { unit: HUNK_A, select: { kind: "lines", changes: [0, 1] } },
            { unit: HUNK_B, select: { kind: "lines", changes: [0] } },
          ],
          changes: [],
        },
        {
          index: 1,
          message: "use parser",
          refs: [
            { unit: HUNK_A, select: { kind: "lines", changes: [2, 3] } },
            { unit: FILE_C, select: { kind: "lines", changes: [] } },
          ],
          changes: [],
        },
      ],
      units: [
        {
          kind: "hunk",
          id: HUNK_A,
          path: "src/a.ts",
          oldStart: 0,
          changeCount: 4,
          body: [
            { op: "-", text: "old1\n", change: 0 },
            { op: "+", text: "new1\n", change: 1 },
            { op: " ", text: "same\n" },
            { op: "-", text: "old2\n", change: 2 },
            { op: "+", text: "new2\n", change: 3 },
          ],
        },
        {
          kind: "hunk",
          id: HUNK_B,
          path: "src/b.ts",
          oldStart: 4,
          changeCount: 1,
          body: [{ op: "+", text: "added\n", change: 0 }],
        },
        {
          kind: "file",
          id: FILE_C,
          path: "logo.png",
          before: null,
          after: { mode: "100644", blob: "4".repeat(40) },
          reason: "binary",
        },
      ],
      comments,
    }),
  );
}

type Running = {
  readonly url: string;
  readonly dir: string;
  readonly done: Promise<Review>;
};

async function start(t: TestContext, state: ReviewState): Promise<Running> {
  const dir = await mkdtemp(join(tmpdir(), "follow-me-server-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const reviewsDir = join(dir, "reviews");
  let announce: (url: string) => void = () => {};
  const listening = new Promise<string>((resolve) => {
    announce = resolve;
  });
  const done = serveReview(state, { reviewsDir, port: 0, onListen: announce });
  return { url: await listening, dir: reviewsDir, done };
}

const hunkAnchor = { kind: "hunk", unit: HUNK_A, commit: 0, changes: [1] };
const newComment = (body: string) => ({
  anchor: hunkAnchor,
  context: { commitMessage: "add parser", path: "src/a.ts" },
  body,
});

// Response.json() is typed unknown; the tests assert on the shapes they read.
async function jsonOf(res: Response) {
  return JSON.parse(await res.text());
}

async function post(url: string, path: string, body: unknown): Promise<Response> {
  return fetch(new URL(path, url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("a review session autosaves a draft and ends by writing the Review", async (t) => {
  const run = await start(t, twoCommitState());

  const initial = await jsonOf(await fetch(new URL("/api/state", run.url)));
  assert.equal(initial.version, 3);
  assert.deepEqual(initial.comments, []);
  assert.equal(initial.commits.length, 2);

  const created = await post(run.url, "/api/comments", newComment("why drop old1?"));
  assert.equal(created.status, 201);
  const { id } = await jsonOf(created);
  assert.match(id, /^c_[a-z2-7]{6}$/);

  const edited = {
    id,
    ...newComment("why drop old1 here?"),
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const put = await fetch(new URL(`/api/comments/${id}`, run.url), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(edited),
  });
  assert.equal(put.status, 200);

  const message = await jsonOf(
    await post(run.url, "/api/comments", {
      anchor: { kind: "message", commit: 1 },
      context: { commitMessage: "use parser", path: null },
      body: "too vague",
    }),
  );
  const gone = await fetch(new URL(`/api/comments/${message.id}`, run.url), { method: "DELETE" });
  assert.equal(gone.status, 200);

  const draft = JSON.parse(await readFile(join(run.dir, "v3.draft.json"), "utf8"));
  assert.deepEqual(draft, {
    schema: "follow-me/review-draft@1",
    planVersion: 3,
    comments: [edited],
  });

  const ended = await post(run.url, "/api/end", {});
  assert.equal(ended.status, 200);
  const review = await run.done;

  const onDisk = JSON.parse(await readFile(join(run.dir, "v3.json"), "utf8"));
  assert.match(onDisk.endedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(onDisk, {
    schema: "follow-me/review@1",
    mode: "split",
    planVersion: 3,
    planHash: "hash-of-v3",
    endedAt: review.endedAt,
    comments: [edited],
  });
  await assert.rejects(stat(join(run.dir, "v3.draft.json")), { code: "ENOENT" });
  await assert.rejects(fetch(new URL("/api/state", run.url)));
});

test("a malformed comment gets 400 and leaves the draft unchanged", async (t) => {
  const run = await start(t, twoCommitState());
  const { id } = await jsonOf(await post(run.url, "/api/comments", newComment("keep me")));
  const draftFile = join(run.dir, "v3.draft.json");
  const before = await readFile(draftFile, "utf8");

  const goodPut = { id, ...newComment("x"), createdAt: "2026-01-01T00:00:00.000Z" };
  const attempts: [string, string, unknown][] = [
    ["POST", "/api/comments", { ...newComment("x"), anchor: { kind: "hunk", unit: "nope" } }],
    ["POST", "/api/comments", { ...newComment("x"), body: 7 }],
    ["POST", "/api/comments", { ...newComment("x"), anchor: { ...hunkAnchor, commit: 9 } }],
    [
      "POST",
      "/api/comments",
      { ...newComment("x"), anchor: { ...hunkAnchor, unit: "h_ffffffffffff" } },
    ],
    ["PUT", `/api/comments/${id}`, { ...goodPut, anchor: { kind: "plan", extra: 1 }, body: null }],
    ["PUT", `/api/comments/${id}`, { ...goodPut, id: "c_zzzzzz" }],
    ["PUT", "/api/comments/c_abcdef", { ...goodPut, id: "bad id" }],
    ["PUT", `/api/comments/${id}`, "not an object"],
  ];
  for (const [method, path, body] of attempts) {
    const res = await fetch(new URL(path, run.url), {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 400, `${method} ${path} ${JSON.stringify(body)}`);
  }
  const garbage = await fetch(new URL("/api/comments", run.url), { method: "POST", body: "{nope" });
  assert.equal(garbage.status, 400);

  assert.equal(await readFile(draftFile, "utf8"), before);
  const state = await jsonOf(await fetch(new URL("/api/state", run.url)));
  assert.equal(state.comments.length, 1);
  assert.equal(state.comments[0].body, "keep me");

  await post(run.url, "/api/end", {});
  await run.done;
});

test("a draft from an unfinished session comes back through loadDraftComments", async (t) => {
  const first = await start(t, twoCommitState());
  const { id } = await jsonOf(await post(first.url, "/api/comments", newComment("pending")));
  const restored = await loadDraftComments(first.dir, twoCommitState().version);
  assert.equal(restored.length, 1);
  assert.equal(restored[0]?.id, id);
  assert.equal(restored[0]?.body, "pending");

  const state = await jsonOf(await fetch(new URL("/api/state", first.url)));
  assert.equal(state.comments[0].id, id);
  await post(first.url, "/api/end", {});
  await first.done;
});

test("requests from a foreign origin are refused", async (t) => {
  const run = await start(t, twoCommitState());
  const res = await fetch(new URL("/api/comments", run.url), {
    method: "POST",
    headers: { origin: "http://evil.example", "content-type": "application/json" },
    body: JSON.stringify(newComment("x")),
  });
  assert.equal(res.status, 403);
  await post(run.url, "/api/end", {});
  await run.done;
});

test("the UI files are served at /, /app.js, /playback.js and /style.css", async (t) => {
  const run = await start(t, twoCommitState());
  const page = await fetch(new URL("/", run.url));
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(await page.text(), /<title>follow-me review<\/title>/);
  const script = await fetch(new URL("/app.js", run.url));
  assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
  const playback = await fetch(new URL("/playback.js", run.url));
  assert.match(await playback.text(), /export function buildScript\(/);
  assert.equal((await fetch(new URL("/style.css", run.url))).status, 200);
  assert.equal((await fetch(new URL("/nope.js", run.url))).status, 404);
  await post(run.url, "/api/end", {});
  await run.done;
});
