import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type TestContext, test } from "node:test";
import type { Host, Loader, Registration, ReviewState } from "./server.ts";
import {
  ago,
  loadDraftComments,
  PortInUseError,
  parseRegistration,
  RegistrationError,
  sessionIdOf,
  startServer,
} from "./server.ts";
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
  readonly done: Promise<Review | null>;
  readonly host: Host;
};

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "follow-me-server-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function registration(dir: string, version = 3): Registration {
  const parsed = parseRegistration({
    dir,
    mode: "split",
    version,
    hash: "hash-of-v3",
    lockToken: null,
  });
  assert.ok(parsed, "a well-formed registration parses");
  return parsed;
}

/** A loader over fixed states keyed by session dir; the real one reads .follow-me/ from disk. */
function fixedLoader(states: ReadonlyMap<string, ReviewState>, released: string[] = []): Loader {
  return async (r) => {
    const state = states.get(r.dir);
    if (!state) throw new RegistrationError(`${r.dir} is not a session`);
    return {
      repo: `/repos${r.dir}`,
      reviewsDir: join(r.dir, "reviews"),
      state,
      release: () => released.push(r.dir),
    };
  };
}

async function serve(t: TestContext, load: Loader, idleMs = 60_000): Promise<Host> {
  const host = await startServer({ port: 0, idleMs, load });
  t.after(() => host.close());
  return host;
}

async function start(t: TestContext, state: ReviewState): Promise<Running> {
  const dir = await tempDir(t);
  const host = await serve(t, fixedLoader(new Map([[dir, state]])));
  const { summary, done } = await host.register(registration(dir));
  return { url: new URL(summary.url, host.url).href, dir: join(dir, "reviews"), done, host };
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

  const initial = await jsonOf(await fetch(new URL("api/state", run.url)));
  assert.equal(initial.version, 3);
  assert.deepEqual(initial.comments, []);
  assert.equal(initial.commits.length, 2);

  const created = await post(run.url, "api/comments", newComment("why drop old1?"));
  assert.equal(created.status, 201);
  const { id } = await jsonOf(created);
  assert.match(id, /^c_[a-z2-7]{6}$/);

  const edited = {
    id,
    ...newComment("why drop old1 here?"),
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const put = await fetch(new URL(`api/comments/${id}`, run.url), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(edited),
  });
  assert.equal(put.status, 200);

  const message = await jsonOf(
    await post(run.url, "api/comments", {
      anchor: { kind: "message", commit: 1 },
      context: { commitMessage: "use parser", path: null },
      body: "too vague",
    }),
  );
  const gone = await fetch(new URL(`api/comments/${message.id}`, run.url), { method: "DELETE" });
  assert.equal(gone.status, 200);

  const draft = JSON.parse(await readFile(join(run.dir, "v3.draft.json"), "utf8"));
  assert.deepEqual(draft, {
    schema: "follow-me/review-draft@1",
    planVersion: 3,
    comments: [edited],
  });

  const ended = await post(run.url, "api/end", {});
  assert.equal(ended.status, 200);
  const review = await run.done;

  const onDisk = JSON.parse(await readFile(join(run.dir, "v3.json"), "utf8"));
  assert.match(onDisk.endedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(onDisk, {
    schema: "follow-me/review@1",
    mode: "split",
    planVersion: 3,
    planHash: "hash-of-v3",
    endedAt: review?.endedAt,
    comments: [edited],
  });
  await assert.rejects(stat(join(run.dir, "v3.draft.json")), { code: "ENOENT" });
  assert.equal((await fetch(new URL("api/state", run.url))).status, 404);
  assert.deepEqual(run.host.sessions(), []);
});

test("a malformed comment gets 400 and leaves the draft unchanged", async (t) => {
  const run = await start(t, twoCommitState());
  const { id } = await jsonOf(await post(run.url, "api/comments", newComment("keep me")));
  const draftFile = join(run.dir, "v3.draft.json");
  const before = await readFile(draftFile, "utf8");

  const goodPut = { id, ...newComment("x"), createdAt: "2026-01-01T00:00:00.000Z" };
  const attempts: [string, string, unknown][] = [
    ["POST", "api/comments", { ...newComment("x"), anchor: { kind: "hunk", unit: "nope" } }],
    ["POST", "api/comments", { ...newComment("x"), body: 7 }],
    ["POST", "api/comments", { ...newComment("x"), anchor: { ...hunkAnchor, commit: 9 } }],
    [
      "POST",
      "api/comments",
      { ...newComment("x"), anchor: { ...hunkAnchor, unit: "h_ffffffffffff" } },
    ],
    ["PUT", `api/comments/${id}`, { ...goodPut, anchor: { kind: "plan", extra: 1 }, body: null }],
    ["PUT", `api/comments/${id}`, { ...goodPut, id: "c_zzzzzz" }],
    ["PUT", "api/comments/c_abcdef", { ...goodPut, id: "bad id" }],
    ["PUT", `api/comments/${id}`, "not an object"],
  ];
  for (const [method, path, body] of attempts) {
    const res = await fetch(new URL(path, run.url), {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 400, `${method} ${path} ${JSON.stringify(body)}`);
  }
  const garbage = await fetch(new URL("api/comments", run.url), { method: "POST", body: "{nope" });
  assert.equal(garbage.status, 400);

  assert.equal(await readFile(draftFile, "utf8"), before);
  const state = await jsonOf(await fetch(new URL("api/state", run.url)));
  assert.equal(state.comments.length, 1);
  assert.equal(state.comments[0].body, "keep me");

  await post(run.url, "api/end", {});
  await run.done;
});

test("a draft from an unfinished session comes back through loadDraftComments", async (t) => {
  const first = await start(t, twoCommitState());
  const { id } = await jsonOf(await post(first.url, "api/comments", newComment("pending")));
  const restored = await loadDraftComments(first.dir, twoCommitState().version);
  assert.equal(restored.length, 1);
  assert.equal(restored[0]?.id, id);
  assert.equal(restored[0]?.body, "pending");

  const state = await jsonOf(await fetch(new URL("api/state", first.url)));
  assert.equal(state.comments[0].id, id);
  await post(first.url, "api/end", {});
  await first.done;
});

test("requests from a foreign origin are refused", async (t) => {
  const run = await start(t, twoCommitState());
  const res = await fetch(new URL("api/comments", run.url), {
    method: "POST",
    headers: { origin: "http://evil.example", "content-type": "application/json" },
    body: JSON.stringify(newComment("x")),
  });
  assert.equal(res.status, 403);
  await post(run.url, "api/end", {});
  await run.done;
});

test("the UI is served under /s/<id>/ and its assets at the root", async (t) => {
  const run = await start(t, twoCommitState());
  const page = await fetch(run.url);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(await page.text(), /<title>follow-me review<\/title>/);
  const bare = await fetch(run.url.slice(0, -1), { redirect: "manual" });
  assert.deepEqual([bare.status, bare.headers.get("location")], [308, new URL(run.url).pathname]);
  const script = await fetch(new URL("/app.js", run.url));
  assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
  const playback = await fetch(new URL("/playback.js", run.url));
  assert.match(await playback.text(), /export function buildScript\(/);
  assert.equal((await fetch(new URL("/style.css", run.url))).status, 200);
  assert.equal((await fetch(new URL("/nope.js", run.url))).status, 404);
  assert.equal((await fetch(new URL("/s/000000000000/", run.url))).status, 404);
  assert.equal((await fetch(new URL("/s/000000000000/api/state", run.url))).status, 404);
  await post(run.url, "api/end", {});
  await run.done;
});

test("the Mermaid bundle and the chunks it imports are served as JavaScript", async (t) => {
  const run = await start(t, twoCommitState());
  const entry = await fetch(new URL("/vendor/mermaid.mjs", run.url));
  assert.deepEqual(
    [entry.status, entry.headers.get("content-type")],
    [200, "text/javascript; charset=utf-8"],
  );
  const body = await entry.text();
  const chunk = /from"\.\/(chunks\/mermaid\.esm\.min\/[\w-]+\.mjs)"/.exec(body)?.[1];
  assert.ok(chunk, "the entry imports a chunk by relative path");
  const imported = await fetch(new URL(`/vendor/${chunk}`, run.url));
  assert.deepEqual(
    [imported.status, imported.headers.get("content-type")],
    [200, "text/javascript; charset=utf-8"],
  );
  assert.equal(
    (await fetch(new URL("/vendor/chunks/mermaid.esm.min/nope.mjs", run.url))).status,
    404,
  );
  assert.equal(
    (await fetch(new URL("/vendor/chunks/mermaid.esm.min/%2e%2e%2fpackage.json", run.url))).status,
    404,
  );
  await post(run.url, "api/end", {});
  await run.done;
});

test("one server hosts two sessions, lists them, and saves each review in its own place", async (t) => {
  const [one, two] = [await tempDir(t), await tempDir(t)];
  const released: string[] = [];
  const states = new Map([
    [one, twoCommitState()],
    [two, twoCommitState()],
  ]);
  const host = await serve(t, fixedLoader(states, released));
  const first = await host.register(registration(one));
  const second = await host.register(registration(two));
  assert.deepEqual(
    [first.summary.url, second.summary.url],
    [`/s/${sessionIdOf(one)}/`, `/s/${sessionIdOf(two)}/`],
  );
  const urlOf = (r: { summary: { url: string } }) => new URL(r.summary.url, host.url).href;
  await post(urlOf(first), "api/comments", newComment("from one"));
  await post(urlOf(second), "api/comments", newComment("from two"));
  await post(urlOf(second), "api/comments", newComment("also two"));

  const listed = await jsonOf(await fetch(new URL("/api/sessions", host.url)));
  assert.deepEqual(listed, [
    {
      id: sessionIdOf(one),
      url: `/s/${sessionIdOf(one)}/`,
      repo: `/repos${one}`,
      branch: "feature",
      mode: "split",
      version: 3,
      comments: 1,
    },
    {
      id: sessionIdOf(two),
      url: `/s/${sessionIdOf(two)}/`,
      repo: `/repos${two}`,
      branch: "feature",
      mode: "split",
      version: 3,
      comments: 2,
    },
  ]);
  const index = await (await fetch(host.url)).text();
  assert.ok(
    index.includes(
      `<a class="session" href="/s/${sessionIdOf(two)}/"><span class="repo">${basename(two)}</span> <span class="branch">feature</span></a>`,
    ),
  );
  assert.ok(index.includes('<span class="mode split">plan review v3</span>'));
  assert.ok(index.includes('<span class="muted">2 comments · opened just now</span>'));

  await Promise.all([post(urlOf(first), "api/end", {}), post(urlOf(second), "api/end", {})]);
  const [a, b] = await Promise.all([first.done, second.done]);
  assert.deepEqual(
    [a?.comments.map((c) => c.body), b?.comments.map((c) => c.body)],
    [["from one"], ["from two", "also two"]],
  );
  const onDisk = JSON.parse(await readFile(join(two, "reviews", "v3.json"), "utf8"));
  assert.deepEqual(
    onDisk.comments.map((c: { body: string }) => c.body),
    ["from two", "also two"],
  );
  assert.deepEqual(released.sort(), [one, two].sort());
  assert.deepEqual(await jsonOf(await fetch(new URL("/api/sessions", host.url))), []);
  assert.match(await (await fetch(host.url)).text(), /<h1>No sessions yet<\/h1>/);
});

test("session ages read as a person would say them", () => {
  assert.deepEqual(
    [ago(30_000), ago(5 * 60_000), ago(3 * 3_600_000), ago(26 * 3_600_000), ago(80 * 3_600_000)],
    ["just now", "5 min ago", "3 h ago", "1 day ago", "3 days ago"],
  );
});

test("registering a session again returns the same URL, and a different plan is refused", async (t) => {
  const dir = await tempDir(t);
  const host = await serve(t, fixedLoader(new Map([[dir, twoCommitState()]])));
  const body = registration(dir);
  const first = await post(host.url, "/api/sessions", body);
  const again = await post(host.url, "/api/sessions", body);
  assert.deepEqual([first.status, again.status], [201, 200]);
  assert.equal((await jsonOf(again)).url, `/s/${sessionIdOf(dir)}/`);
  const other = await post(host.url, "/api/sessions", registration(dir, 4));
  assert.deepEqual(
    [other.status, await jsonOf(other)],
    [409, { error: "this session is already open as a review of plan v3; end it first" }],
  );
  const unknown = await post(host.url, "/api/sessions", registration("/elsewhere"));
  assert.deepEqual(
    [unknown.status, await jsonOf(unknown)],
    [409, { error: "/elsewhere is not a session" }],
  );
  const malformed = await post(host.url, "/api/sessions", { ...body, dir: "relative" });
  assert.equal(malformed.status, 400);
  assert.equal(host.sessions().length, 1);
});

test("the server answers health with its marker and stops once idle with no session", async (t) => {
  const dir = await tempDir(t);
  const host = await serve(t, fixedLoader(new Map([[dir, twoCommitState()]])), 50);
  const health = await jsonOf(await fetch(new URL("/api/health", host.url)));
  assert.deepEqual(health, { app: "follow-me", pid: process.pid });

  const { summary, done } = await host.register(registration(dir));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(host.sessions().length, 1, "a hosted session keeps the server up");
  await post(new URL(summary.url, host.url).href, "api/end", {});
  assert.equal((await done)?.planVersion, 3);
  await host.closed;
  await assert.rejects(fetch(new URL("/api/health", host.url)));
});

test("closing the server abandons open sessions without writing a review", async (t) => {
  const run = await start(t, twoCommitState());
  await post(run.url, "api/comments", newComment("kept in the draft"));
  await run.host.close();
  assert.equal(await run.done, null);
  await assert.rejects(stat(join(run.dir, "v3.json")), { code: "ENOENT" });
  assert.equal(
    (await loadDraftComments(run.dir, twoCommitState().version))[0]?.body,
    "kept in the draft",
  );
});

test("a taken port is reported as PortInUseError", async (t) => {
  const first = await serve(t, fixedLoader(new Map()));
  await assert.rejects(
    startServer({ port: first.port, idleMs: 0, load: fixedLoader(new Map()) }),
    (error: unknown) => error instanceof PortInUseError && error.port === first.port,
  );
});
