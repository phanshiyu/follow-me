import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPlanVersion } from "./plan.ts";
import { isLockToken } from "./session.ts";
import type {
  Anchor,
  Comment,
  CommentId,
  HostedSummary,
  LockToken,
  PlanVersion,
  ProjectedCommit,
  RepoPath,
  Review,
  ReviewMode,
  SessionAnchor,
  SessionId,
  Unit,
  UnitId,
} from "./types.ts";

export type ReviewState = {
  readonly mode: ReviewMode;
  readonly anchor: SessionAnchor;
  readonly version: PlanVersion;
  readonly planHash: string;
  readonly commits: readonly ProjectedCommit[];
  readonly units: readonly Unit[];
  /** An autosaved draft from an earlier unfinished session of the same version. */
  readonly comments: readonly Comment[];
};

/** Body of POST /api/sessions: which session to host and the lock its sender hands over. */
export type Registration = {
  readonly dir: string;
  readonly mode: ReviewMode;
  readonly version: PlanVersion;
  readonly hash: string;
  /** The lock the registering process holds, or null to take the session's lock while free. */
  readonly lockToken: LockToken | null;
};

/** A session ready to host: what the page shows, where its reviews go, and the lock it owns. */
export type Loaded = {
  readonly repo: string;
  readonly reviewsDir: string;
  readonly state: ReviewState;
  readonly release: () => void;
};

/** Turns a registration into a hosted session. Throws RegistrationError to refuse it. */
export type Loader = (registration: Registration) => Promise<Loaded>;

export type Registered = {
  readonly summary: HostedSummary;
  /** The review once the session ends, or null if the server stops first. */
  readonly done: Promise<Review | null>;
};

export type Host = {
  readonly port: number;
  readonly url: string;
  register(registration: Registration): Promise<Registered>;
  sessions(): readonly HostedSummary[];
  /** Releases every hosted lock without writing reviews; drafts stay autosaved. */
  close(): Promise<void>;
  /** Resolves when the server stopped, by close() or after idleMs without a session. */
  readonly closed: Promise<void>;
};

export type HostOptions = {
  /** 0 picks a free port. */
  readonly port: number;
  /** How long the server waits for a new session after its last one ended. */
  readonly idleMs: number;
  readonly load: Loader;
};

/** The requested port is taken; host.ts decides whether that is our server or a stranger. */
export class PortInUseError extends Error {
  override readonly name = "PortInUseError";
  readonly port: number;
  constructor(port: number) {
    super(`port ${port} is in use`);
    this.port = port;
  }
}

/** A session the server cannot host, with the reason the CLI shows. */
export class RegistrationError extends Error {
  override readonly name = "RegistrationError";
}

/** GET /api/health answers with this, so a CLI can tell our server from another program. */
export const HEALTH_APP = "follow-me";

const UI_DIR = new URL("../ui/", import.meta.url);
/** Every module and the stylesheet in ui/ is served flat, so a new module needs no route. */
const STATIC_FILE = /^\/([a-z][a-z-]*\.(?:js|css))$/;
const STATIC_TYPES = new Map([
  ["js", "text/javascript; charset=utf-8"],
  ["css", "text/css; charset=utf-8"],
]);
/** Mermaid's ESM entry imports its chunks by relative path, so they are served beside it. */
const MERMAID_ENTRY = new URL(import.meta.resolve("mermaid/dist/mermaid.esm.min.mjs"));
const MERMAID_CHUNK = /^\/vendor\/chunks\/mermaid\.esm\.min\/([\w-]+\.mjs)$/;
/** Prism is a plain script per component, loaded one at a time by the page as languages need. */
const PRISM_CORE = new URL(import.meta.resolve("prismjs/components/prism-core.min.js"));
const PRISM_PATH = /^\/vendor\/prism\/([a-z][a-z-]*)\.js$/;
const MAX_BODY_BYTES = 1_000_000;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

const COMMENT_ID = /^c_[a-z2-7]{6}$/;
const UNIT_ID = /^[hfm]_[0-9a-f]{12}(~\d+)?$/;
const SESSION_ID = /^[0-9a-f]{12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCommentId(value: unknown): value is CommentId {
  return typeof value === "string" && COMMENT_ID.test(value);
}

function isUnitId(value: unknown): value is UnitId {
  return typeof value === "string" && UNIT_ID.test(value);
}

function isRepoPath(value: unknown): value is RepoPath {
  return typeof value === "string" && value.length > 0;
}

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isSessionId(value: unknown): value is SessionId {
  return typeof value === "string" && SESSION_ID.test(value);
}

/** Derived from the session directory, so registering one session twice yields one id. */
export function sessionIdOf(dir: string): SessionId {
  const id = createHash("sha256").update(dir).digest("hex").slice(0, 12);
  if (!isSessionId(id)) throw new Error(`sha256 produced ${id}`);
  return id;
}

export function sessionPath(id: SessionId): string {
  return `/s/${id}/`;
}

function parseAnchor(raw: unknown): Anchor | null {
  if (!isRecord(raw)) return null;
  const commit = raw["commit"];
  switch (raw["kind"]) {
    case "plan":
      return { kind: "plan" };
    case "message":
      return isIndex(commit) ? { kind: "message", commit } : null;
    case "position":
      return isIndex(commit) ? { kind: "position", commit } : null;
    case "hunk": {
      const unit = raw["unit"];
      const changes = raw["changes"];
      if (!isIndex(commit) || !isUnitId(unit)) return null;
      if (changes === null) return { kind: "hunk", unit, commit, changes: null };
      if (!Array.isArray(changes) || !changes.every(isIndex)) return null;
      return { kind: "hunk", unit, commit, changes };
    }
    default:
      return null;
  }
}

/** The one place untrusted JSON becomes a Comment. Returns null when any field is wrong. */
export function parseComment(raw: unknown): Comment | null {
  if (!isRecord(raw)) return null;
  const { id, body, createdAt } = raw;
  const context = raw["context"];
  const anchor = parseAnchor(raw["anchor"]);
  if (!isCommentId(id) || !anchor || !isRecord(context)) return null;
  const { commitMessage, path } = context;
  if (typeof commitMessage !== "string" || typeof body !== "string") return null;
  if (typeof createdAt !== "string") return null;
  if (path !== null && !isRepoPath(path)) return null;
  return { id, anchor, context: { commitMessage, path }, body, createdAt };
}

/** The one place untrusted JSON becomes a Registration. */
export function parseRegistration(raw: unknown): Registration | null {
  if (!isRecord(raw)) return null;
  const { dir, mode, version, hash, lockToken } = raw;
  if (typeof dir !== "string" || !isAbsolute(dir)) return null;
  if (mode !== "split" && mode !== "walk") return null;
  if (!isPlanVersion(version) || typeof hash !== "string" || hash === "") return null;
  if (lockToken !== null && !isLockToken(lockToken)) return null;
  return { dir, mode, version, hash, lockToken };
}

function draftPath(reviewsDir: string, version: PlanVersion): string {
  return join(reviewsDir, `v${version}.draft.json`);
}

/** Comments autosaved by an unfinished review of this version, or none. */
export async function loadDraftComments(
  reviewsDir: string,
  version: PlanVersion,
): Promise<readonly Comment[]> {
  let text: string;
  try {
    text = await readFile(draftPath(reviewsDir, version), "utf8");
  } catch (error) {
    if (isRecord(error) && error["code"] === "ENOENT") return [];
    throw error;
  }
  const raw: unknown = JSON.parse(text);
  const list = isRecord(raw) ? raw["comments"] : null;
  if (!Array.isArray(list)) throw new Error(`malformed review draft for v${version}`);
  return list.flatMap((item: unknown) => {
    const comment = parseComment(item);
    return comment ? [comment] : [];
  });
}

async function writeAtomic(path: string, text: string): Promise<void> {
  // The pid lets `follow-me clean` tell an abandoned temp file from one being written.
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, text);
  await rename(temp, path);
}

function mintCommentId(taken: ReadonlySet<string>): CommentId {
  for (;;) {
    let id = "c_";
    for (const byte of randomBytes(6)) id += BASE32.charAt(byte % 32);
    if (isCommentId(id) && !taken.has(id)) return id;
  }
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** "just now", "5 min ago", "2 h ago" or "3 days ago". */
export function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function tildePath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

type IndexRow = { readonly summary: HostedSummary; readonly openedAt: number };

function indexPage(rows: readonly IndexRow[], now: number): string {
  const items = rows.map(({ summary: s, openedAt }) => {
    const mode =
      s.mode === "walk"
        ? '<span class="mode walk">code review</span>'
        : `<span class="mode split">plan review v${s.version}</span>`;
    const count = `${s.comments} comment${s.comments === 1 ? "" : "s"}`;
    const repo = escapeHtml(basename(s.repo));
    return `      <li>
        <a class="session" href="${s.url}"><span class="repo">${repo}</span> <span class="branch">${escapeHtml(s.branch)}</span></a>
        ${mode}
        <span class="muted">${count} · opened ${ago(now - openedAt)}</span>
        <span class="path muted">${escapeHtml(tildePath(s.repo))}</span>
      </li>`;
  });
  const body =
    items.length === 0
      ? `    <section class="empty">
      <h1>No sessions yet</h1>
      <p>Run <code>follow-me review</code> to review a plan, or <code>follow-me walk</code> to read a branch someone else wrote. Each one opens here.</p>
      <p><a href="https://github.com/phanshiyu/follow-me#readme">How follow-me works</a></p>
    </section>`
      : `    <h1>Sessions</h1>
    <ul class="session-index">
${items.join("\n")}
    </ul>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>follow-me sessions</title>
    <link rel="stylesheet" href="/style.css" />
  </head>
  <body class="index">
    <header class="topbar"><strong>follow-me</strong></header>
    <main class="index-main">
${body}
    </main>
  </body>
</html>
`;
}

/** The file behind a /vendor/ path, or null. Chunk names are checked, so no path escapes. */
function vendorFile(path: string): URL | null {
  const part = PRISM_PATH.exec(path)?.[1];
  if (part !== undefined) {
    return part === "core" ? PRISM_CORE : new URL(`prism-${part}.min.js`, PRISM_CORE);
  }
  if (path === "/vendor/mermaid.mjs") return MERMAID_ENTRY;
  const chunk = MERMAID_CHUNK.exec(path)?.[1];
  return chunk === undefined ? null : new URL(`chunks/mermaid.esm.min/${chunk}`, MERMAID_ENTRY);
}

async function readUi(name: string): Promise<Buffer> {
  try {
    return await readFile(fileURLToPath(new URL(name, UI_DIR)));
  } catch (error) {
    if (isRecord(error) && error["code"] === "ENOENT") throw new HttpError(404, "not found");
    throw error;
  }
}

async function sendVendor(res: ServerResponse, file: URL): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = await readFile(fileURLToPath(file));
  } catch (error) {
    if (isRecord(error) && error["code"] === "ENOENT") throw new HttpError(404, "not found");
    throw error;
  }
  // The bundle only changes with the installed package, and it is several megabytes.
  res.writeHead(200, {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "max-age=86400",
  });
  res.end(bytes);
}

/** One hosted review: its comments, its autosave chain, and how it ends. */
function hostSession(id: SessionId, registration: Registration, loaded: Loaded) {
  const { state, reviewsDir } = loaded;
  const openedAt = Date.now();
  const comments = new Map<string, Comment>(state.comments.map((c) => [c.id, c]));
  const unitIds = new Set<string>(state.units.map((u) => u.id));
  const draftFile = draftPath(reviewsDir, state.version);
  const reviewFile = join(reviewsDir, `v${state.version}.json`);
  let finish: (review: Review | null) => void = () => {};
  const done = new Promise<Review | null>((resolve) => {
    finish = resolve;
  });

  let ending = false;
  // Writes are chained so two rapid edits never race on the same file.
  let writes: Promise<void> = Promise.resolve();
  const saveDraft = (): Promise<void> => {
    const snapshot = JSON.stringify(
      {
        schema: "follow-me/review-draft@1",
        planVersion: state.version,
        comments: [...comments.values()],
      },
      null,
      2,
    );
    writes = writes.then(async () => {
      await mkdir(reviewsDir, { recursive: true });
      await writeAtomic(draftFile, `${snapshot}\n`);
    });
    return writes;
  };

  const accept = (comment: Comment | null): Comment => {
    if (!comment) throw new HttpError(400, "malformed comment");
    const { anchor } = comment;
    if (anchor.kind !== "plan" && anchor.commit >= state.commits.length) {
      throw new HttpError(400, "anchor commit out of range");
    }
    if (anchor.kind === "hunk" && !unitIds.has(anchor.unit)) {
      throw new HttpError(400, "anchor names an unknown unit");
    }
    return comment;
  };

  return {
    id,
    registration,
    done,
    openedAt,
    summary: (): HostedSummary => ({
      id,
      url: sessionPath(id),
      repo: loaded.repo,
      branch: state.anchor.branch,
      mode: state.mode,
      version: state.version,
      comments: comments.size,
    }),
    snapshot: () => ({ ...state, comments: [...comments.values()] }),
    add: async (raw: unknown): Promise<CommentId> => {
      if (!isRecord(raw)) throw new HttpError(400, "malformed comment");
      const commentId = mintCommentId(new Set(comments.keys()));
      const comment = accept(
        parseComment({ ...raw, id: commentId, createdAt: new Date().toISOString() }),
      );
      comments.set(commentId, comment);
      await saveDraft();
      return commentId;
    },
    put: async (target: string, raw: unknown): Promise<Comment> => {
      const comment = accept(parseComment(raw));
      if (comment.id !== target) throw new HttpError(400, "comment id does not match the URL");
      comments.set(comment.id, comment);
      await saveDraft();
      return comment;
    },
    remove: async (target: string): Promise<void> => {
      if (!comments.delete(target)) throw new HttpError(404, "no such comment");
      await saveDraft();
    },
    /** Writes reviews/vN.json exactly once and releases the session's lock. */
    end: async (): Promise<{ review: Review; file: string }> => {
      if (ending) throw new HttpError(409, "this review is already ending");
      ending = true;
      await writes;
      const review: Review = {
        schema: "follow-me/review@1",
        mode: state.mode,
        planVersion: state.version,
        planHash: state.planHash,
        endedAt: new Date().toISOString(),
        comments: [...comments.values()],
      };
      await mkdir(reviewsDir, { recursive: true });
      await writeAtomic(reviewFile, `${JSON.stringify(review, null, 2)}\n`);
      await rm(draftFile, { force: true });
      loaded.release();
      return { review, file: reviewFile };
    },
    finish: (review: Review | null) => finish(review),
    abandon: () => {
      loaded.release();
      finish(null);
    },
  };
}

type HostedSession = ReturnType<typeof hostSession>;

function sameRegistration(a: Registration, b: Registration): boolean {
  return a.dir === b.dir && a.mode === b.mode && a.version === b.version && a.hash === b.hash;
}

/**
 * Starts the server that hosts every review of this user. Sessions live in a registry keyed by
 * SessionId; each one is served at /s/<id>/ with its API under /s/<id>/api/. The server stops
 * itself once it has had no session for idleMs.
 */
export function startServer(opts: HostOptions): Promise<Host> {
  const registry = new Map<SessionId, HostedSession>();
  const pending = new Map<SessionId, Promise<HostedSession>>();
  let boundPort = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  let stopped = false;
  let markClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });

  const server: Server = createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
      if (error instanceof RegistrationError) return sendJson(res, 409, { error: error.message });
      console.error(error);
      sendJson(res, 500, { error: "internal error" });
    });
  });

  const close = (): Promise<void> => {
    if (!stopped) {
      stopped = true;
      clearTimeout(idleTimer);
      for (const session of registry.values()) session.abandon();
      registry.clear();
      server.close(() => markClosed());
      server.closeAllConnections();
    }
    return closed;
  };

  const settle = (): void => {
    clearTimeout(idleTimer);
    if (stopped || registry.size > 0 || pending.size > 0) return;
    idleTimer = setTimeout(() => void close(), opts.idleMs);
  };

  const sessions = (): HostedSummary[] => [...registry.values()].map((s) => s.summary());

  const register = async (registration: Registration): Promise<Registered> => {
    if (stopped) throw new RegistrationError("the server is stopping");
    const id = sessionIdOf(registration.dir);
    const existing = registry.get(id) ?? (await pending.get(id));
    if (existing) {
      if (!sameRegistration(existing.registration, registration)) {
        const { mode, version } = existing.registration;
        throw new RegistrationError(
          `this session is already open as a ${mode === "walk" ? "walk" : "review"} of plan v${version}; end it first`,
        );
      }
      return { summary: existing.summary(), done: existing.done };
    }
    clearTimeout(idleTimer);
    const loading = opts.load(registration).then((loaded) => hostSession(id, registration, loaded));
    pending.set(id, loading);
    try {
      const session = await loading;
      registry.set(id, session);
      return { summary: session.summary(), done: session.done };
    } finally {
      pending.delete(id);
      settle();
    }
  };

  const hosted = (raw: string): HostedSession => {
    const session = isSessionId(raw) ? registry.get(raw) : undefined;
    if (!session) throw new HttpError(404, "no such session; it ended or never existed");
    return session;
  };

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host ?? "";
    // Blocks DNS rebinding and cross-site writes: only our own origin may talk to the API.
    if (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`) {
      throw new HttpError(403, "unexpected host");
    }
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) throw new HttpError(403, "bad origin");

    const method = req.method ?? "GET";
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    const asset = method === "GET" ? STATIC_FILE.exec(path)?.[1] : undefined;
    if (asset !== undefined) {
      const bytes = await readUi(asset);
      const type = STATIC_TYPES.get(asset.slice(asset.lastIndexOf(".") + 1));
      res.writeHead(200, { "content-type": type ?? "text/plain", "cache-control": "no-store" });
      res.end(bytes);
      return;
    }

    const vendor = method === "GET" ? vendorFile(path) : null;
    if (vendor) return sendVendor(res, vendor);

    if (method === "GET" && path === "/") {
      const rows = [...registry.values()].map((h) => ({
        summary: h.summary(),
        openedAt: h.openedAt,
      }));
      return sendHtml(res, 200, indexPage(rows, Date.now()));
    }
    if (method === "GET" && path === "/api/health") {
      return sendJson(res, 200, { app: HEALTH_APP, pid: process.pid });
    }
    if (method === "GET" && path === "/api/sessions") return sendJson(res, 200, sessions());
    if (method === "POST" && path === "/api/sessions") {
      const registration = parseRegistration(await readJson(req));
      if (!registration) throw new HttpError(400, "malformed registration");
      const before = registry.has(sessionIdOf(registration.dir));
      const { summary } = await register(registration);
      return sendJson(res, before ? 200 : 201, summary);
    }

    const match = /^\/s\/([^/]+)(\/.*)?$/.exec(path);
    if (match === null) throw new HttpError(404, "not found");
    const [, rawId = "", rest] = match;
    if (rest === undefined && method === "GET") {
      res.writeHead(308, { location: `/s/${encodeURIComponent(rawId)}/` });
      res.end();
      return;
    }
    if (method === "GET" && rest === "/") {
      if (!isSessionId(rawId) || !registry.has(rawId)) {
        return sendHtml(
          res,
          404,
          '<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="color-scheme" content="light dark" /><title>follow-me</title><link rel="stylesheet" href="/style.css" /></head><body class="index"><header class="topbar"><strong>follow-me</strong></header><main class="index-main"><section class="empty"><h1>This session has ended</h1><p>It finished, or it never existed. <a href="/">All sessions</a></p></section></main></body></html>\n',
        );
      }
      return sendHtml(
        res,
        200,
        await readFile(fileURLToPath(new URL("index.html", UI_DIR)), "utf8"),
      );
    }

    const session = hosted(rawId);
    if (method === "GET" && rest === "/api/state") return sendJson(res, 200, session.snapshot());
    if (method === "POST" && rest === "/api/comments") {
      return sendJson(res, 201, { id: await session.add(await readJson(req)) });
    }
    const target = /^\/api\/comments\/([^/]+)$/.exec(rest ?? "")?.[1];
    if (target !== undefined && method === "PUT") {
      return sendJson(res, 200, await session.put(target, await readJson(req)));
    }
    if (target !== undefined && method === "DELETE") {
      await session.remove(target);
      return sendJson(res, 200, { deleted: target });
    }
    if (method === "POST" && rest === "/api/end") {
      const { review, file } = await session.end();
      registry.delete(session.id);
      sendJson(res, 200, { saved: file });
      res.on("close", () => {
        session.finish(review);
        settle();
      });
      return;
    }
    throw new HttpError(404, "not found");
  }

  return new Promise<Host>((resolve, reject) => {
    server.once("error", (error) => {
      if (isRecord(error) && error["code"] === "EADDRINUSE") reject(new PortInUseError(opts.port));
      else reject(error);
    });
    server.listen(opts.port, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("server has no port"));
      boundPort = address.port;
      settle();
      resolve({
        port: boundPort,
        url: `http://127.0.0.1:${boundPort}/`,
        register,
        sessions,
        close,
        closed,
      });
    });
  });
}
