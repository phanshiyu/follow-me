import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Anchor,
  Comment,
  CommentId,
  PlanVersion,
  ProjectedCommit,
  RepoPath,
  Review,
  ReviewMode,
  SessionAnchor,
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

export type ServeOptions = {
  readonly reviewsDir: string;
  readonly port?: number;
  readonly open?: boolean;
  /** Called once with the URL the server is listening on. */
  readonly onListen?: (url: string) => void;
};

const UI_DIR = new URL("../ui/", import.meta.url);
const STATIC_FILES = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/playback.js", { file: "playback.js", type: "text/javascript; charset=utf-8" }],
  ["/style.css", { file: "style.css", type: "text/css; charset=utf-8" }],
]);
const MAX_BODY_BYTES = 1_000_000;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

const COMMENT_ID = /^c_[a-z2-7]{6}$/;
const UNIT_ID = /^[hfm]_[0-9a-f]{12}(~\d+)?$/;

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

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [url], { stdio: "ignore", detached: true });
  child.on("error", (error) => console.error(`could not open a browser: ${error.message}`));
  child.unref();
}

export function serveReview(state: ReviewState, opts: ServeOptions): Promise<Review> {
  const { reviewsDir } = opts;
  const comments = new Map<string, Comment>(state.comments.map((c) => [c.id, c]));
  const unitIds = new Set<string>(state.units.map((u) => u.id));
  const draftFile = draftPath(reviewsDir, state.version);
  const reviewFile = join(reviewsDir, `v${state.version}.json`);
  let boundPort = 0;

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

  return new Promise<Review>((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      route(req, res).catch((error: unknown) => {
        if (error instanceof HttpError)
          return sendJson(res, error.status, { error: error.message });
        console.error(error);
        sendJson(res, 500, { error: "internal error" });
      });
    });

    async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const host = req.headers.host ?? "";
      // Blocks DNS rebinding and cross-site writes: only our own origin may talk to the API.
      if (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`) {
        throw new HttpError(403, "unexpected host");
      }
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://${host}`)
        throw new HttpError(403, "bad origin");

      const method = req.method ?? "GET";
      const path = new URL(req.url ?? "/", "http://localhost").pathname;

      const asset = method === "GET" ? STATIC_FILES.get(path) : undefined;
      if (asset) {
        const bytes = await readFile(fileURLToPath(new URL(asset.file, UI_DIR)));
        res.writeHead(200, { "content-type": asset.type, "cache-control": "no-store" });
        res.end(bytes);
        return;
      }

      if (method === "GET" && path === "/api/state") {
        return sendJson(res, 200, { ...state, comments: [...comments.values()] });
      }

      if (method === "POST" && path === "/api/comments") {
        const raw = await readJson(req);
        if (!isRecord(raw)) throw new HttpError(400, "malformed comment");
        const id = mintCommentId(new Set(comments.keys()));
        const comment = accept(parseComment({ ...raw, id, createdAt: new Date().toISOString() }));
        comments.set(id, comment);
        await saveDraft();
        return sendJson(res, 201, { id });
      }

      const target = /^\/api\/comments\/([^/]+)$/.exec(path)?.[1];
      if (target !== undefined && method === "PUT") {
        const comment = accept(parseComment(await readJson(req)));
        if (comment.id !== target) throw new HttpError(400, "comment id does not match the URL");
        comments.set(comment.id, comment);
        await saveDraft();
        return sendJson(res, 200, comment);
      }
      if (target !== undefined && method === "DELETE") {
        if (!comments.delete(target)) throw new HttpError(404, "no such comment");
        await saveDraft();
        return sendJson(res, 200, { deleted: target });
      }

      if (method === "POST" && path === "/api/end") {
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
        sendJson(res, 200, { saved: reviewFile });
        res.on("close", () => {
          server.close(() => resolve(review));
          server.closeAllConnections();
        });
        return;
      }

      throw new HttpError(404, "not found");
    }

    server.on("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("server has no port"));
      boundPort = address.port;
      const url = `http://127.0.0.1:${boundPort}/`;
      const label = state.mode === "walk" ? "code review" : "review";
      process.stdout.write(`follow-me ${label}: ${url}\n`);
      opts.onListen?.(url);
      if (opts.open) openBrowser(url);
    });
  });
}
