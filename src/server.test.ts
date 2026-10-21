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
import type { PreviousVersion, Review } from "./types.ts";

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
      previous: null,
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

test("Prism components are served by name and nothing else is reachable through the route", async (t) => {
  const run = await start(t, twoCommitState());
  for (const name of ["core", "clike", "javascript", "markup-templating"]) {
    const res = await fetch(new URL(`/vendor/prism/${name}.js`, run.url));
    assert.deepEqual(
      [name, res.status, res.headers.get("content-type")],
      [name, 200, "text/javascript; charset=utf-8"],
    );
  }
  for (const bad of ["nope", "%2e%2e%2fpackage", "..%2fcomponents%2fprism-core"]) {
    assert.equal((await fetch(new URL(`/vendor/prism/${bad}.js`, run.url))).status, 404, bad);
  }
  assert.equal((await fetch(new URL("/highlight.js", run.url))).status, 200);
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

const CONCERN = "k_0a1b2c3d";

/** The two-commit state with one agent concern on the first commit's first hunk. */
function stateWithConcern(): ReviewState {
  const state = twoCommitState();
  return JSON.parse(
    JSON.stringify({
      ...state,
      commits: state.commits.map((c, i) =>
        i === 0
          ? {
              ...c,
              concerns: [
                {
                  id: CONCERN,
                  unit: HUNK_A,
                  severity: "major",
                  kind: "bug",
                  text: "old1 is dropped without its guard.",
                  lines: [1],
                },
              ],
            }
          : c,
      ),
    }),
  );
}

/** A loader whose state follows the registered version, as the real one's does. */
function versionedLoader(released: string[], refuse = 0): Loader {
  return async (r, held) => {
    if (r.version === refuse) throw new RegistrationError(`plan v${r.version} no longer fits`);
    // JSON.parse is the only brand-free way to build branded literals without a cast.
    const previous: PreviousVersion | null =
      r.version > 3
        ? JSON.parse(
            JSON.stringify({
              version: 3,
              comments: [],
              responses: [{ comment: "c_abcdef", status: "answered", note: "see v4" }],
            }),
          )
        : null;
    return {
      repo: "/repo",
      reviewsDir: join(r.dir, "reviews"),
      state: { ...twoCommitState(), version: r.version, planHash: r.hash },
      release: held ?? (() => released.push(r.dir)),
      previous,
    };
  };
}

async function startVersioned(t: TestContext, refuse = 0) {
  const dir = await tempDir(t);
  const released: string[] = [];
  const host = await serve(t, versionedLoader(released, refuse));
  const { summary, done } = await host.register(registration(dir));
  const url = new URL(summary.url, host.url).href;
  return { url, dir, reviews: join(dir, "reviews"), host, done, released };
}

async function eventsOf(url: string, since: number, timeout: number) {
  return jsonOf(await fetch(new URL(`api/events?since=${since}&timeout=${timeout}`, url)));
}

test("events: a poll returns at once when news exists, wakes on news and times out empty", async (t) => {
  const run = await start(t, stateWithConcern());
  assert.deepEqual(await eventsOf(run.url, 0, 50), { seq: 0, events: [] });

  const waiting = eventsOf(run.url, 0, 20_000);
  const { id } = await jsonOf(await post(run.url, "api/comments", newComment("why drop old1?")));
  const woken = await waiting;
  assert.equal(woken.seq, 1);
  assert.deepEqual(
    woken.events.map((e: { seq: number; type: string }) => [e.seq, e.type]),
    [[1, "comment"]],
  );
  assert.equal(woken.events[0].comment.id, id);

  // News after `since` is returned without waiting, so a long timeout costs nothing.
  const edited = {
    id,
    ...newComment("why drop old1 here?"),
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  await fetch(new URL(`api/comments/${id}`, run.url), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(edited),
  });
  await post(run.url, `api/comments/${id}/replies`, { author: "agent", body: "see the guard" });
  await post(run.url, `api/concerns/${CONCERN}`, {
    decision: "kept",
    severity: "blocker",
    note: "yes",
  });
  await fetch(new URL(`api/comments/${id}`, run.url), { method: "DELETE" });
  const all = await eventsOf(run.url, 0, 60_000);
  assert.deepEqual(
    all.events.map((e: { seq: number; type: string }) => [e.seq, e.type]),
    [
      [1, "comment"],
      [2, "comment-updated"],
      [3, "reply"],
      [4, "concern"],
      [5, "comment-deleted"],
    ],
  );
  assert.equal(all.seq, 5);
  assert.equal(all.events[2].commentId, id);
  assert.equal(all.events[2].reply.author, "agent");
  assert.match(all.events[3].decidedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(
    { ...all.events[3], seq: 0, decidedAt: undefined },
    {
      seq: 0,
      decidedAt: undefined,
      type: "concern",
      concernId: CONCERN,
      decision: "kept",
      severity: "blocker",
      note: "yes",
    },
  );
  assert.deepEqual(all.events[4], { seq: 5, type: "comment-deleted", id });
  assert.deepEqual(
    (await eventsOf(run.url, 3, 60_000)).events.map((e: { seq: number }) => e.seq),
    [4, 5],
  );

  const ending = eventsOf(run.url, 5, 20_000);
  await post(run.url, "api/end", {});
  const last = await ending;
  assert.deepEqual(last.events, [{ seq: 6, type: "ended", review: join(run.dir, "v3.json") }]);
});

test("events: a bad cursor or timeout is refused", async (t) => {
  const run = await start(t, twoCommitState());
  for (const query of ["since=-1", "since=x", "timeout=-5", "timeout="]) {
    const res = await fetch(new URL(`api/events?${query}`, run.url));
    assert.equal(res.status, 400, query);
  }
  const ahead = await fetch(new URL("api/events?since=9&timeout=10", run.url));
  assert.equal(ahead.status, 409);
});

test("a reply lives on its comment, survives the page's edits and lands in the saved review", async (t) => {
  const run = await start(t, twoCommitState());
  const { id } = await jsonOf(await post(run.url, "api/comments", newComment("why drop old1?")));

  const diagram = "flowchart LR\n  a --> b";
  const res = await post(run.url, `api/comments/${id}/replies`, {
    author: "agent",
    body: "It is replaced one line later.",
    diagram,
  });
  assert.equal(res.status, 201);
  const reply = await jsonOf(res);
  assert.match(reply.id, /^r_[a-z2-7]{6}$/);
  await post(run.url, `api/comments/${id}/replies`, { author: "reviewer", body: "ok, thanks" });

  const state = await jsonOf(await fetch(new URL("api/state", run.url)));
  assert.deepEqual(
    state.comments[0].replies.map((r: { author: string; body: string }) => [r.author, r.body]),
    [
      ["agent", "It is replaced one line later."],
      ["reviewer", "ok, thanks"],
    ],
  );
  assert.equal(state.comments[0].replies[0].diagram, diagram);

  // The page's copy of the comment has no replies; saving it must not erase the conversation.
  const stale = { id, ...newComment("why drop old1 here?"), createdAt: "2026-01-01T00:00:00.000Z" };
  const put = await fetch(new URL(`api/comments/${id}`, run.url), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(stale),
  });
  assert.equal((await jsonOf(put)).replies.length, 2);

  const draft = JSON.parse(await readFile(join(run.dir, "v3.draft.json"), "utf8"));
  assert.equal(draft.comments[0].replies[0].id, reply.id);

  await post(run.url, "api/end", {});
  await run.done;
  const saved = JSON.parse(await readFile(join(run.dir, "v3.json"), "utf8"));
  assert.equal(saved.comments[0].body, "why drop old1 here?");
  assert.deepEqual(
    saved.comments[0].replies.map((r: { author: string }) => r.author),
    ["agent", "reviewer"],
  );
});

test("a malformed reply gets 400 and an unknown comment 404", async (t) => {
  const run = await start(t, twoCommitState());
  const { id } = await jsonOf(await post(run.url, "api/comments", newComment("q")));
  const attempts: unknown[] = [
    { author: "robot", body: "x" },
    { author: "agent", body: "  " },
    { author: "agent", body: 3 },
    { author: "agent", body: "x", diagram: "just words" },
    "text",
  ];
  for (const body of attempts) {
    assert.equal((await post(run.url, `api/comments/${id}/replies`, body)).status, 400);
  }
  const missing = await post(run.url, "api/comments/c_zzzzzz/replies", {
    author: "agent",
    body: "x",
  });
  assert.equal(missing.status, 404);
  const state = await jsonOf(await fetch(new URL("api/state", run.url)));
  assert.equal(state.comments[0].replies, undefined);
});

test("concern decisions and questions reach the saved review, the report and its markdown file", async (t) => {
  const run = await start(t, stateWithConcern());
  const initial = await jsonOf(await fetch(new URL("api/state", run.url)));
  assert.equal(initial.commits[0].concerns[0].id, CONCERN);
  assert.deepEqual(initial.concerns, []);
  assert.equal(initial.previous, null);
  assert.equal(initial.seq, 0);

  for (const body of [{ decision: "maybe" }, { decision: "kept", severity: "huge" }, "kept"]) {
    assert.equal((await post(run.url, `api/concerns/${CONCERN}`, body)).status, 400);
  }
  assert.equal((await post(run.url, "api/concerns/k_ffffffff", { decision: "kept" })).status, 404);
  const decided = await post(run.url, `api/concerns/${CONCERN}`, {
    decision: "kept",
    severity: "blocker",
    note: "Agreed.",
  });
  assert.equal(decided.status, 200);
  await post(run.url, "api/comments", {
    ...newComment("why drop old1?"),
    kind: "question",
    context: { commitMessage: "add parser", path: "src/a.ts", lines: ["-old1", "+new1"] },
  });

  const md = await fetch(new URL("api/report", run.url));
  assert.equal(md.status, 200);
  assert.match(md.headers.get("content-type") ?? "", /^text\/markdown/);
  const live = await md.text();
  assert.ok(
    live.includes("### line 1 · blocker · bug · raised by the agent, kept by the reviewer"),
  );
  assert.ok(live.includes("Agent: old1 is dropped without its guard.\nReviewer: Agreed."));
  assert.ok(live.includes("Reviewer asked: why drop old1?"));

  const draft = JSON.parse(await readFile(join(run.dir, "v3.draft.json"), "utf8"));
  const [stamped] = draft.concerns;
  assert.match(stamped.decidedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(draft.concerns, [
    {
      concern: CONCERN,
      decision: "kept",
      severity: "blocker",
      note: "Agreed.",
      decidedAt: stamped.decidedAt,
    },
  ]);

  // The server owns the time: a client cannot back-date a decision, and a second one restamps.
  await post(run.url, `api/concerns/${CONCERN}`, {
    decision: "dismissed",
    decidedAt: "2000-01-01T00:00:00.000Z",
  });
  const second = JSON.parse(await readFile(join(run.dir, "v3.draft.json"), "utf8"));
  assert.notEqual(second.concerns[0].decidedAt, "2000-01-01T00:00:00.000Z");
  assert.ok(second.concerns[0].decidedAt >= stamped.decidedAt);
  await post(run.url, `api/concerns/${CONCERN}`, {
    decision: "kept",
    severity: "blocker",
    note: "Agreed.",
  });

  await post(run.url, "api/end", {});
  await run.done;
  const saved = JSON.parse(await readFile(join(run.dir, "v3.json"), "utf8"));
  assert.equal(saved.concerns[0].decision, "kept");
  assert.match(saved.concerns[0].decidedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(saved.comments[0].kind, "question");
  assert.deepEqual(saved.comments[0].context.lines, ["-old1", "+new1"]);
  const file = await readFile(join(run.dir, "v3.md"), "utf8");
  assert.ok(file.startsWith("# Review of plan v3\n"));
  assert.ok(file.includes("## Code issues (1 issue: 1 blocker)"));
});

test("a version swap keeps the URL, finalizes the old draft and starts a fresh comment set", async (t) => {
  const run = await startVersioned(t);
  const { id } = await jsonOf(await post(run.url, "api/comments", newComment("why drop old1?")));
  await post(run.url, `api/comments/${id}/replies`, { author: "agent", body: "on it" });

  const swapped = await post(run.url, "api/version", { version: 4, hash: "hash-of-v4" });
  assert.equal(swapped.status, 200);
  const summary = await jsonOf(swapped);
  assert.equal(new URL(summary.url, run.host.url).href, run.url);
  assert.equal(summary.version, 4);
  assert.equal(run.host.sessions().length, 1);
  assert.deepEqual(run.released, [], "the lock moves with the session, it is not released");

  const state = await jsonOf(await fetch(new URL("api/state", run.url)));
  assert.equal(state.version, 4);
  assert.equal(state.planHash, "hash-of-v4");
  assert.deepEqual(state.comments, []);
  assert.equal(state.previous.version, 3);
  assert.equal(state.previous.responses[0].status, "answered");
  assert.equal(state.seq, 3);

  const old = JSON.parse(await readFile(join(run.reviews, "v3.json"), "utf8"));
  assert.equal(old.mode, "split");
  assert.equal(old.planVersion, 3);
  assert.equal(old.comments[0].id, id);
  assert.equal(old.comments[0].replies[0].body, "on it");
  assert.ok((await readFile(join(run.reviews, "v3.md"), "utf8")).startsWith("# Review of plan v3"));
  await assert.rejects(stat(join(run.reviews, "v3.draft.json")), { code: "ENOENT" });

  const events = await eventsOf(run.url, 2, 10);
  assert.deepEqual(events.events, [{ seq: 3, type: "version", version: 4, hash: "hash-of-v4" }]);

  // New comments belong to v4, and a swap with nothing said writes no review.
  const next = await jsonOf(await post(run.url, "api/comments", newComment("and now?")));
  assert.ok((await readFile(join(run.reviews, "v4.draft.json"), "utf8")).includes(next.id));
  await post(run.url, "api/end", {});
  await run.done;
  assert.deepEqual(run.released, [run.dir]);
  assert.equal(JSON.parse(await readFile(join(run.reviews, "v4.json"), "utf8")).planVersion, 4);
});

test("a swap with nothing said writes no review, and bad swaps change nothing", async (t) => {
  const run = await startVersioned(t, 9);
  assert.equal((await post(run.url, "api/version", { version: 4, hash: "h4" })).status, 200);
  await assert.rejects(stat(join(run.reviews, "v3.json")), { code: "ENOENT" });
  await assert.rejects(stat(join(run.reviews, "v3.draft.json")), { code: "ENOENT" });

  const noop = await post(run.url, "api/version", { version: 4, hash: "h4" });
  assert.equal(noop.status, 200);
  assert.equal((await eventsOf(run.url, 0, 10)).seq, 1, "no second version event");
  const attempts: [unknown, number][] = [
    [{ version: 4, hash: "other" }, 409],
    [{ version: 3, hash: "old" }, 409],
    [{ version: 9, hash: "gone" }, 409],
    [{ version: 0, hash: "x" }, 400],
    [{ version: 5 }, 400],
    ["v5", 400],
  ];
  for (const [body, status] of attempts) {
    assert.equal((await post(run.url, "api/version", body)).status, status, JSON.stringify(body));
  }
  const state = await jsonOf(await fetch(new URL("api/state", run.url)));
  assert.equal(state.version, 4);
});

/** Reads data frames from an event stream until `count` arrived or the stream closed. */
async function frames(res: Response, count: number) {
  const reader = res.body?.getReader();
  assert.ok(reader, "the stream has a body");
  const decoder = new TextDecoder();
  let text = "";
  let closed = false;
  while (text.split("\n\n").filter((f) => f.includes("data: ")).length < count) {
    const { done, value } = await reader.read();
    if (done) {
      closed = true;
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  if (!closed) {
    // Whether the server closes the stream is part of what callers assert.
    const next = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 300)),
    ]);
    closed = next?.done === true;
  }
  const events = text
    .split("\n\n")
    .flatMap((f) => (f.includes("data: ") ? [f] : []))
    .map((f) => ({
      id: /^id: (\d+)$/m.exec(f)?.[1],
      data: JSON.parse(/^data: (.*)$/m.exec(f)?.[1] ?? "null"),
    }));
  return { events, closed, text };
}

test("the event stream replays, pushes new events and closes after the end", async (t) => {
  const run = await start(t, twoCommitState());
  await post(run.url, "api/comments", newComment("first"));

  const res = await fetch(new URL("api/events/stream?since=0", run.url));
  assert.match(res.headers.get("content-type") ?? "", /^text\/event-stream/);
  const pushed = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await post(run.url, "api/comments", newComment("second"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await post(run.url, "api/end", {});
  })();
  const seen = await frames(res, 3);
  await pushed;
  assert.deepEqual(
    seen.events.map((e) => [e.id, e.data.type]),
    [
      ["1", "comment"],
      ["2", "comment"],
      ["3", "ended"],
    ],
  );
  assert.equal(seen.events[0]?.data.comment.body, "first");
  assert.equal(seen.events[1]?.data.comment.body, "second");
  assert.ok(seen.closed, "the stream closes after the ended event");
});

test("a reconnecting stream resumes after Last-Event-ID, and a cursor ahead is refused", async (t) => {
  const run = await start(t, twoCommitState());
  await post(run.url, "api/comments", newComment("first"));
  await post(run.url, "api/comments", newComment("second"));
  const res = await fetch(new URL("api/events/stream", run.url), {
    headers: { "last-event-id": "1" },
  });
  const seen = await frames(res, 1);
  assert.deepEqual(
    seen.events.map((e) => e.id),
    ["2"],
  );
  assert.equal((await fetch(new URL("api/events/stream?since=9", run.url))).status, 409);
  assert.equal((await fetch(new URL("api/events/stream?since=x", run.url))).status, 400);
});

const rowsAnchor = (offsets: readonly number[], changes: readonly number[]) => ({
  kind: "hunk",
  unit: HUNK_A,
  commit: 0,
  changes,
  offsets,
});

test("row offsets, context rows included, survive POST, PUT, state, autosave and the review file", async (t) => {
  const run = await start(t, twoCommitState());
  const mixed = {
    ...newComment("why is same untouched?"),
    anchor: rowsAnchor([1, 2], [1]),
    context: { commitMessage: "add parser", path: "src/a.ts", lines: ["+new1", " same"] },
  };
  const contextOnly = { ...mixed, anchor: rowsAnchor([2], []), body: "what is same for?" };
  const a = await jsonOf(await post(run.url, "api/comments", mixed));
  const b = await jsonOf(await post(run.url, "api/comments", contextOnly));

  const put = await fetch(new URL(`api/comments/${a.id}`, run.url), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...mixed, id: a.id, createdAt: "2026-01-01T00:00:00.000Z" }),
  });
  assert.equal(put.status, 200);

  const state = await jsonOf(await fetch(new URL("api/state", run.url)));
  assert.deepEqual(state.comments[0].anchor.offsets, [1, 2]);
  assert.deepEqual(state.comments[1].anchor, rowsAnchor([2], []));
  assert.deepEqual(state.comments[1].context.lines, ["+new1", " same"]);
  const draft = JSON.parse(await readFile(join(run.dir, "v3.draft.json"), "utf8"));
  assert.deepEqual(draft.comments[0].anchor.offsets, [1, 2]);
  assert.deepEqual(draft.comments[1].anchor, rowsAnchor([2], []));

  await post(run.url, "api/end", {});
  await run.done;
  const saved = JSON.parse(await readFile(join(run.dir, "v3.json"), "utf8"));
  assert.deepEqual(saved.comments[0].anchor, rowsAnchor([1, 2], [1]));
  assert.deepEqual(saved.comments[1].anchor, rowsAnchor([2], []));
  assert.equal(saved.comments[1].id, b.id);
});

test("an agent-authored comment is accepted, shown in state and events, and a reviewer cannot fake one", async (t) => {
  const run = await start(t, twoCommitState());
  const posted = await post(run.url, "api/comments", {
    ...newComment("Here is why."),
    author: "agent",
    diagram: "flowchart LR\n  a --> b",
  });
  assert.equal(posted.status, 201);
  const state = await jsonOf(await fetch(new URL("api/state", run.url)));
  assert.equal(state.comments[0].author, "agent");
  assert.equal(state.comments[0].diagram, "flowchart LR\n  a --> b");
  const events = await jsonOf(await fetch(new URL("api/events?since=0&timeout=0", run.url)));
  assert.equal(events.events[0].comment.author, "agent");

  const reviewer = await post(run.url, "api/comments", newComment("A question."));
  assert.equal(
    (await jsonOf(await fetch(new URL("api/state", run.url)))).comments[1].author,
    undefined,
  );
  assert.equal(reviewer.status, 201);
  for (const extra of [
    { author: "reviewer" },
    { author: "agent", diagram: "not mermaid" },
    { diagram: "flowchart LR\n  a --> b" },
  ]) {
    const res = await post(run.url, "api/comments", { ...newComment("x"), ...extra });
    assert.equal(res.status, 400, JSON.stringify(extra));
  }
});

test("offsets outside the hunk body, unsorted or on a file unit are refused and change nothing", async (t) => {
  const run = await start(t, twoCommitState());
  await post(run.url, "api/comments", newComment("kept"));
  const before = await readFile(join(run.dir, "v3.draft.json"), "utf8");
  const bad = [
    rowsAnchor([5], []),
    rowsAnchor([0, 99], [0]),
    rowsAnchor([2, 1], []),
    rowsAnchor([1, 1], []),
    rowsAnchor([-1], []),
    rowsAnchor([], []),
    { ...rowsAnchor([0], []), unit: FILE_C },
    { ...rowsAnchor([0], []), changes: null },
  ];
  for (const anchor of bad) {
    const res = await post(run.url, "api/comments", { ...newComment("x"), anchor });
    assert.equal(res.status, 400, JSON.stringify(anchor));
  }
  assert.equal(await readFile(join(run.dir, "v3.draft.json"), "utf8"), before);
  const state = await jsonOf(await fetch(new URL("api/state", run.url)));
  assert.equal(state.comments.length, 1);
});

test("a pending flag is held from the agent until submit; a question is never held", async (t) => {
  const run = await start(t, twoCommitState());
  const agentEvents = async (since: number) =>
    jsonOf(await fetch(new URL(`api/events?since=${since}&timeout=0&audience=agent`, run.url)));

  const flag = await jsonOf(
    await post(run.url, "api/comments", {
      ...newComment("guard this"),
      severity: "major",
      pending: true,
    }),
  );
  assert.deepEqual(await agentEvents(0), { seq: 1, events: [] });
  // The page still receives it, and it is autosaved.
  const page = await jsonOf(await fetch(new URL("api/events?since=0&timeout=0", run.url)));
  assert.equal(page.events.length, 1);
  const draft = JSON.parse(await readFile(join(run.dir, "v3.draft.json"), "utf8"));
  assert.equal(draft.comments[0].pending, true);
  const live = await (await fetch(new URL("api/report", run.url))).text();
  assert.doesNotMatch(live, /guard this/);

  const question = await jsonOf(
    await post(run.url, "api/comments", { ...newComment("why?"), kind: "question" }),
  );
  const seen = await agentEvents(0);
  assert.deepEqual(
    seen.events.map((e: { type: string; comment: { id: string } }) => [e.type, e.comment.id]),
    [["comment", question.id]],
  );
  const refused = await post(run.url, "api/comments", {
    ...newComment("x"),
    kind: "question",
    pending: true,
  });
  assert.equal(refused.status, 400);

  const submitted = await jsonOf(await post(run.url, "api/submit", {}));
  assert.deepEqual(submitted, { released: 1 });
  const after = await agentEvents(0);
  assert.deepEqual(
    after.events.map((e: { type: string }) => e.type),
    ["comment", "submitted", "comment"],
  );
  assert.equal(after.events[2].comment.id, flag.id);
  assert.equal("pending" in after.events[2].comment, false);
  assert.match(await (await fetch(new URL("api/report", run.url))).text(), /guard this/);
  assert.deepEqual(await jsonOf(await post(run.url, "api/submit", {})), { released: 0 });
});

test("ending the review submits pending flags into the saved review", async (t) => {
  const run = await start(t, twoCommitState());
  await post(run.url, "api/comments", { ...newComment("held"), severity: "minor", pending: true });
  await post(run.url, "api/end", {});
  const review = await run.done;
  assert.equal(review?.comments.length, 1);
  assert.equal(review?.comments[0]?.pending, undefined);
});
