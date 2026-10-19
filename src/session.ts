import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { isRepoPath, isSha, isUnitId } from "./diff.ts";
import {
  branchExists,
  currentBranch,
  defaultBaseRef,
  GitError,
  loadDiff,
  objectsDir,
  QUARANTINE_PREFIX,
  repoRoot,
  resolveCommit,
} from "./git.ts";
import {
  isArray,
  isCommentId,
  isFields,
  isPlanVersion,
  parsePlanFile,
  planHash,
  serializePlanFile,
  type ValidPlan,
} from "./plan.ts";
import type {
  Anchor,
  Applied,
  Comment,
  Diff,
  LockToken,
  PlanFile,
  PlanVersion,
  Review,
  ReviewMode,
  SessionAnchor,
  Sha,
} from "./types.ts";

export class BranchMovedError extends Error {
  override readonly name = "BranchMovedError";
}

/** A file under .follow-me/ that exists but cannot be read as what it claims to be. */
export class SessionFileError extends Error {
  override readonly name = "SessionFileError";
}

/** draft.json has not been written yet. */
export class MissingDraftError extends SessionFileError {
  readonly path: string;
  constructor(path: string) {
    super(`${path} does not exist yet`);
    this.path = path;
  }
}

/** The command ran outside any git work tree. */
export class NotARepositoryError extends Error {
  override readonly name = "NotARepositoryError";
  constructor() {
    super("not a git repository (run it inside the repo you want to split)");
  }
}

/** Another live follow-me process holds the session's lock. */
export class SessionLockedError extends Error {
  override readonly name = "SessionLockedError";
}

/** Who holds <session>/lock. "stale" means the holder's pid is gone. */
export type LockState =
  | { readonly kind: "free" }
  | { readonly kind: "held" | "stale"; readonly pid: number; readonly command: string };

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

export function readLock(path: string): LockState {
  const raw = readJson(path);
  if (raw === undefined) return { kind: "free" };
  if (!isFields<"pid" | "command">(raw)) throw new SessionFileError(`${path} is not a lock`);
  const { pid, command } = raw;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    throw new SessionFileError(`${path} is not a lock`);
  }
  if (typeof command !== "string") throw new SessionFileError(`${path} is not a lock`);
  return { kind: isAlive(pid) ? "held" : "stale", pid, command };
}

/** A lock this process holds. release() removes it only while it still carries this token. */
export type HeldLock = { readonly token: LockToken; release(): void };

const LOCK_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isLockToken(value: unknown): value is LockToken {
  return typeof value === "string" && LOCK_TOKEN.test(value);
}

function newToken(): LockToken {
  const token = randomUUID();
  if (!isLockToken(token)) throw new Error(`randomUUID returned ${token}`);
  return token;
}

function lockContent(command: string, token: LockToken): string {
  return `${JSON.stringify({ pid: process.pid, command, token })}\n`;
}

function holding(path: string, token: LockToken): HeldLock {
  return {
    token,
    release: () => {
      const raw = readJson(path);
      if (isFields<"token">(raw) && raw.token === token) rmSync(path, { force: true });
    },
  };
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * Takes <dir>/lock for this process. The lock is written whole to a temp file and linked into
 * place, which fails like open(wx) when the lock exists, so a reader never sees a half-written
 * lock. A lock whose pid is dead is taken over.
 */
function acquireLock(dir: string, branch: string, command: string): HeldLock {
  const path = join(dir, "lock");
  const token = newToken();
  mkdirSync(dir, { recursive: true });
  for (let attempt = 0; ; attempt++) {
    const temp = `${path}.${process.pid}.${token}.tmp`;
    writeFileSync(temp, lockContent(command, token));
    try {
      linkSync(temp, path);
      break;
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
    } finally {
      rmSync(temp, { force: true });
    }
    const state = readLock(path);
    if (state.kind === "held" || attempt > 0) {
      const who = state.kind === "free" ? "another process" : `pid ${state.pid}`;
      const what = state.kind === "free" ? "follow-me" : `follow-me ${state.command}`;
      throw new SessionLockedError(
        `the session for ${branch} is busy: ${who} is running ${what}; wait for it to finish or stop it`,
      );
    }
    rmSync(path, { force: true });
  }
  return holding(path, token);
}

/**
 * Takes over a lock another live process holds and is handing over, identified by its token.
 * The holder waits for the handoff to finish, so nobody else can take the lock between the read
 * and the rename; the old holder's release then finds a foreign token and leaves the lock alone.
 */
function adoptLock(dir: string, from: LockToken, command: string): HeldLock {
  const path = join(dir, "lock");
  const raw = readJson(path);
  if (!isFields<"token">(raw) || raw.token !== from) {
    throw new SessionLockedError(`${path} is not held by the process handing it over`);
  }
  const token = newToken();
  const temp = `${path}.${process.pid}.${token}.tmp`;
  writeFileSync(temp, lockContent(command, token));
  renameSync(temp, path);
  return holding(path, token);
}

export type StoredPlan = {
  readonly version: PlanVersion;
  readonly file: PlanFile;
  readonly hash: string;
};
export type StoredReview = { readonly version: PlanVersion; readonly review: Review };

export type Session = {
  /** Repository top level. */
  readonly root: string;
  /** <root>/.follow-me/<slug> */
  readonly dir: string;
  readonly anchor: SessionAnchor;
  readonly diff: Diff;
  readonly draftPath: string;
  /** <dir>/prompt.md, the planner prompt written for an agent to read. */
  readonly promptPath: string;
  plans(): StoredPlan[];
  /** Where reviews of this mode go: reviews/ for split, reviews/walk/ for walk. */
  reviewsDir(mode: ReviewMode): string;
  /** Every reviews/vN.json. Files from before walk reviews had their own slot can be walk reviews. */
  reviews(): StoredReview[];
  /** reviews/walk/vN.json, plus older walk reviews stored as reviews/vN.json. */
  walkReviews(): StoredReview[];
  /** The split-mode review with the highest version, or null. Walk reviews never feed the planner. */
  lastReview(): Review | null;
  readDraft(): unknown;
  writeDraft(draft: unknown): void;
  writePrompt(text: string): void;
  /** Written once per plan version and mode; a second write to the same slot throws. */
  writeReview(review: Review): void;
  /** Writes plans/vN.json unless the latest plan has the same hash. */
  freeze(plan: ValidPlan): PlanVersion;
  applied(): Applied | null;
  /** Serializes apply and review on this session; throws SessionLockedError when busy. */
  lock(command: string): HeldLock;
  /** Takes over the lock a live process holds with this token, so exactly one process owns it. */
  adoptLock(from: LockToken, command: string): HeldLock;
  lockState(): LockState;
  recordApplied(
    plan: { readonly version: PlanVersion; readonly hash: string },
    result: { readonly branch: string; readonly head: Sha; readonly signed: boolean },
  ): void;
};

export function slugOf(branch: string): string {
  return branch.replaceAll("/", "-");
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}

function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SessionFileError(`${path}: ${error instanceof Error ? error.message : error}`);
  }
}

function versions(dir: string): { version: PlanVersion; path: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((name) => {
      const n = Number(/^v([1-9][0-9]*)\.json$/.exec(name)?.[1]);
      return isPlanVersion(n) ? [{ version: n, path: join(dir, name) }] : [];
    })
    .sort((a, b) => a.version - b.version);
}

function parseAnchor(v: unknown): SessionAnchor | null {
  if (!isFields<"schema" | "branch" | "baseRef" | "base" | "tip" | "tipTree">(v)) return null;
  const { schema, branch, baseRef, base, tip, tipTree } = v;
  if (schema !== "follow-me/session@1" || typeof branch !== "string") return null;
  if (typeof baseRef !== "string") return null;
  if (typeof base !== "string" || typeof tip !== "string" || typeof tipTree !== "string") {
    return null;
  }
  if (!isSha(base) || !isSha(tip) || !isSha(tipTree)) return null;
  return { schema, branch, baseRef, base, tip, tipTree };
}

function parseApplied(v: unknown): Applied | null {
  if (!isFields<"schema" | "version" | "branch" | "head" | "hash" | "signed">(v)) return null;
  const { schema, version, branch, head, hash = null, signed = null } = v;
  if (schema !== "follow-me/applied@1" || !isPlanVersion(version)) return null;
  if (typeof branch !== "string" || typeof head !== "string" || !isSha(head)) return null;
  if (hash !== null && typeof hash !== "string") return null;
  if (signed !== null && typeof signed !== "boolean") return null;
  return { schema, version, branch, head, hash, signed };
}

function isCommitIndex(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function parseCommentAnchor(v: unknown): Anchor | string {
  if (!isFields<"kind" | "unit" | "commit" | "changes">(v)) return "anchor is not an object";
  if (v.kind === "plan") return { kind: "plan" };
  if (!isCommitIndex(v.commit)) return "anchor.commit is not a commit index";
  const commit = v.commit;
  if (v.kind === "message" || v.kind === "position") return { kind: v.kind, commit };
  if (v.kind !== "hunk") return "anchor.kind is unknown";
  if (typeof v.unit !== "string" || !isUnitId(v.unit)) return "anchor.unit is not a unit id";
  if (v.changes === null) return { kind: "hunk", unit: v.unit, commit, changes: null };
  if (!isArray(v.changes) || !v.changes.every(isCommitIndex)) {
    return "anchor.changes is not null or a list of change indices";
  }
  return { kind: "hunk", unit: v.unit, commit, changes: v.changes.filter(isCommitIndex) };
}

function parseComment(v: unknown): Comment | string {
  if (!isFields<"id" | "anchor" | "context" | "body" | "createdAt">(v)) return "not an object";
  if (typeof v.id !== "string" || !isCommentId(v.id)) return "id is not a comment id";
  const anchor = parseCommentAnchor(v.anchor);
  if (typeof anchor === "string") return anchor;
  const ctx = v.context;
  if (!isFields<"commitMessage" | "path">(ctx) || typeof ctx.commitMessage !== "string") {
    return "context.commitMessage is not a string";
  }
  const path = ctx.path;
  if (path !== null && (typeof path !== "string" || !isRepoPath(path))) {
    return "context.path is not null or a path";
  }
  if (typeof v.body !== "string" || typeof v.createdAt !== "string") {
    return "body and createdAt must be strings";
  }
  return {
    id: v.id,
    anchor,
    context: { commitMessage: ctx.commitMessage, path },
    body: v.body,
    createdAt: v.createdAt,
  };
}

/** Boundary parse of reviews/vN.json. Files written before walk mode existed have no mode. */
export function parseReview(v: unknown): Review | string {
  if (!isFields<"schema" | "mode" | "planVersion" | "planHash" | "endedAt" | "comments">(v)) {
    return "not an object";
  }
  if (v.schema !== "follow-me/review@1") return 'schema is not "follow-me/review@1"';
  const mode = v.mode ?? "split";
  if (mode !== "split" && mode !== "walk") return 'mode is not "split" or "walk"';
  if (!isPlanVersion(v.planVersion)) return "planVersion is not a positive integer";
  if (typeof v.planHash !== "string" || typeof v.endedAt !== "string") {
    return "planHash and endedAt must be strings";
  }
  if (!isArray(v.comments)) return "comments is not an array";
  const comments: Comment[] = [];
  for (const [i, raw] of v.comments.entries()) {
    const c = parseComment(raw);
    if (typeof c === "string") return `comments[${i}]: ${c}`;
    comments.push(c);
  }
  return {
    schema: v.schema,
    mode,
    planVersion: v.planVersion,
    planHash: v.planHash,
    endedAt: v.endedAt,
    comments,
  };
}

function makeSession(root: string, dir: string, anchor: SessionAnchor, diff: Diff): Session {
  const plansDir = join(dir, "plans");
  const splitReviews = join(dir, "reviews");
  const walkReviewsDir = join(splitReviews, "walk");
  const reviewsDir = (mode: ReviewMode): string =>
    mode === "walk" ? walkReviewsDir : splitReviews;
  const draftPath = join(dir, "draft.json");
  const promptPath = join(dir, "prompt.md");
  const appliedPath = join(dir, "applied.json");

  const plans = (): StoredPlan[] =>
    versions(plansDir).map(({ version, path }) => {
      const file = parsePlanFile(readJson(path));
      if (Array.isArray(file)) {
        const first = file[0];
        const reason = first?.kind === "malformed" ? `${first.at} ${first.reason}` : first?.kind;
        throw new SessionFileError(`${path}: ${reason}`);
      }
      return { version, file, hash: planHash(file) };
    });

  const reviewsIn = (mode: ReviewMode): StoredReview[] =>
    versions(reviewsDir(mode)).map(({ version, path }) => {
      const review = parseReview(readJson(path));
      if (typeof review === "string") throw new SessionFileError(`${path}: ${review}`);
      return { version, review };
    });
  const reviews = (): StoredReview[] => reviewsIn("split");
  const walkReviews = (): StoredReview[] =>
    [...reviews().filter((r) => r.review.mode === "walk"), ...reviewsIn("walk")].sort(
      (a, b) => a.version - b.version,
    );

  return {
    root,
    dir,
    anchor,
    diff,
    draftPath,
    promptPath,
    plans,
    reviewsDir,
    reviews,
    walkReviews,
    lastReview: () => reviews().findLast((r) => r.review.mode === "split")?.review ?? null,
    readDraft: () => {
      const draft = readJson(draftPath);
      if (draft === undefined) throw new MissingDraftError(draftPath);
      return draft;
    },
    writeDraft: (draft) => writeJson(draftPath, draft),
    writePrompt: (text) => writeText(promptPath, text),
    writeReview: (review) => {
      const path = join(reviewsDir(review.mode), `v${review.planVersion}.json`);
      if (existsSync(path)) throw new SessionFileError(`${path} is already written`);
      writeJson(path, review);
    },
    freeze: (plan) => {
      const latest = plans().at(-1);
      if (latest?.hash === plan.hash) return latest.version;
      const version = (latest?.version ?? 0) + 1;
      if (!isPlanVersion(version)) throw new Error(`invalid next version ${version}`);
      writeJson(join(plansDir, `v${version}.json`), serializePlanFile(plan.file));
      return version;
    },
    lock: (command) => acquireLock(dir, anchor.branch, command),
    adoptLock: (from, command) => adoptLock(dir, from, command),
    lockState: () => readLock(join(dir, "lock")),
    applied: () => {
      const raw = readJson(appliedPath);
      if (raw === undefined) return null;
      const applied = parseApplied(raw);
      if (applied === null) throw new SessionFileError(`${appliedPath} is not an applied record`);
      return applied;
    },
    recordApplied: (plan, result) =>
      writeJson(appliedPath, {
        schema: "follow-me/applied@1",
        version: plan.version,
        branch: result.branch,
        head: result.head,
        hash: plan.hash,
        signed: result.signed,
      } satisfies Applied),
  };
}

type Where = { readonly root: string; readonly branch: string; readonly dir: string };

/** The top level of the work tree holding cwd. */
async function rootOf(cwd: string): Promise<string> {
  try {
    return await repoRoot(cwd);
  } catch (error) {
    if (error instanceof GitError && error.message.includes("not a git repository")) {
      throw new NotARepositoryError();
    }
    throw error;
  }
}

async function locate(repo: string, branch: string | undefined): Promise<Where> {
  const root = await rootOf(repo);
  const name = branch ?? (await currentBranch(root));
  if (name === null) throw new Error("HEAD is detached; pass --branch <name>");
  const top = join(root, ".follow-me");
  mkdirSync(top, { recursive: true });
  const ignore = join(top, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  return { root, branch: name, dir: join(top, slugOf(name)) };
}

function readAnchorIn(dir: string): SessionAnchor | null {
  const path = join(dir, "session.json");
  const raw = readJson(path);
  if (raw === undefined) return null;
  const anchor = parseAnchor(raw);
  if (anchor === null) throw new SessionFileError(`${path} is not a session anchor`);
  return anchor;
}

function readAnchor(where: Where): SessionAnchor | null {
  const anchor = readAnchorIn(where.dir);
  if (anchor === null) return null;
  if (anchor.branch !== where.branch) {
    throw new SessionFileError(
      `${where.dir} holds the session of branch ${anchor.branch}, and ${where.branch} maps to the same directory; rename one of the two branches`,
    );
  }
  return anchor;
}

/** Anchors the session to the branch's current tip, creating it if needed. Plans and reviews stay. */
export async function extractSession(
  repo: string,
  opts: { readonly branch?: string; readonly base?: string } = {},
): Promise<Session> {
  const where = await locate(repo, opts.branch);
  const baseRef = opts.base ?? readAnchor(where)?.baseRef ?? (await defaultBaseRef(where.root));
  const diff = await loadDiff(where.root, baseRef, where.branch);
  const anchor: SessionAnchor = {
    schema: "follow-me/session@1",
    branch: where.branch,
    baseRef,
    base: diff.base,
    tip: diff.tip,
    tipTree: diff.tipTree,
  };
  writeJson(join(where.dir, "session.json"), anchor);
  return makeSession(where.root, where.dir, anchor, diff);
}

/** Opens the session for a branch, creating it on first use. Throws if the branch moved since. */
export async function openSession(
  repo: string,
  opts: { readonly branch?: string; readonly base?: string } = {},
): Promise<Session> {
  const where = await locate(repo, opts.branch);
  const anchor = readAnchor(where);
  if (anchor === null) return extractSession(where.root, { ...opts, branch: where.branch });
  const tip = await resolveCommit(where.root, where.branch);
  if (tip !== anchor.tip) {
    throw new BranchMovedError(
      `${where.branch} moved from ${anchor.tip.slice(0, 12)} to ${tip.slice(0, 12)} since extract; run "follow-me extract" again`,
    );
  }
  const diff = await loadDiff(where.root, anchor.base, anchor.tip);
  return makeSession(where.root, where.dir, anchor, diff);
}

/**
 * Opens the session stored in a `<root>/.follow-me/<slug>` directory, as the review server does
 * when a CLI registers it. Throws like openSession when the branch moved.
 */
export async function openSessionAt(dir: string): Promise<Session> {
  const top = dirname(dir);
  if (basename(top) !== ".follow-me")
    throw new SessionFileError(`${dir} is not a session directory`);
  const anchor = readAnchorIn(dir);
  if (anchor === null) throw new SessionFileError(`${dir} has no session.json`);
  if (slugOf(anchor.branch) !== basename(dir)) {
    throw new SessionFileError(`${dir} holds the session of branch ${anchor.branch}`);
  }
  return openSession(dirname(top), { branch: anchor.branch });
}

/** "<name>.<pid>.<random>.tmp" as written by writeJson, the lock and the review server. */
function abandonedTemps(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => {
      const pid = Number(/\.([0-9]+)\.[0-9a-f-]+\.tmp$/.exec(name)?.[1]);
      return Number.isInteger(pid) && pid > 0 && !isAlive(pid);
    })
    .sort()
    .map((name) => join(dir, name));
}

/** Review drafts for a version at or below the latest finished review; none can be resumed. */
function deadReviewDrafts(reviewsDir: string): string[] {
  const latest = versions(reviewsDir).at(-1)?.version ?? 0;
  if (!existsSync(reviewsDir)) return [];
  return readdirSync(reviewsDir)
    .filter((name) => {
      const n = Number(/^v([1-9][0-9]*)\.draft\.json$/.exec(name)?.[1]);
      return Number.isInteger(n) && n <= latest;
    })
    .sort()
    .map((name) => join(reviewsDir, name));
}

/**
 * Finds what follow-me left behind in this worktree: sessions whose branch is gone, review drafts
 * no review can resume, locks and temp files of dead processes, and object quarantines of dead
 * applies. With all, the whole .follow-me/ directory. Removes them unless dryRun. Sessions held by
 * a live process are left alone, and all refuses while one exists.
 */
export async function cleanSessions(
  repo: string,
  opts: { readonly all: boolean; readonly dryRun: boolean },
): Promise<string[]> {
  const root = await rootOf(repo);
  const top = join(root, ".follow-me");
  const sessions = existsSync(top)
    ? readdirSync(top, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(top, e.name))
        .sort()
    : [];
  const found: string[] = [];
  for (const dir of sessions) {
    const lock = readLock(join(dir, "lock"));
    if (lock.kind === "held") {
      if (!opts.all) continue;
      throw new SessionLockedError(
        `${dir} is busy: pid ${lock.pid} is running follow-me ${lock.command}; wait for it to finish or stop it`,
      );
    }
    if (opts.all) continue;
    const anchor = readAnchorIn(dir);
    if (anchor !== null && !(await branchExists(root, anchor.branch))) {
      found.push(dir);
      continue;
    }
    if (lock.kind === "stale") found.push(join(dir, "lock"));
    const reviews = join(dir, "reviews");
    found.push(
      ...abandonedTemps(dir),
      ...deadReviewDrafts(reviews),
      ...deadReviewDrafts(join(reviews, "walk")),
    );
  }
  if (opts.all && existsSync(top)) found.push(top);
  const objects = await objectsDir(root);
  for (const name of readdirSync(objects).sort()) {
    if (!name.startsWith(QUARANTINE_PREFIX)) continue;
    const pid = Number(name.slice(QUARANTINE_PREFIX.length).split("-")[0]);
    if (Number.isInteger(pid) && !isAlive(pid)) found.push(join(objects, name));
  }
  if (!opts.dryRun) for (const path of found) rmSync(path, { recursive: true, force: true });
  return found;
}
