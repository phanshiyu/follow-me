import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseDraft, parseReview } from "./comments.ts";
import { freshFiles, parseCoverage, serializeCoverage, staleFiles } from "./coverage.ts";
import { isSha } from "./diff.ts";
import { type Evolution, evolvePlan } from "./evolve.ts";
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
  isFields,
  isPlanVersion,
  parsePlanFile,
  planHash,
  serializePlanFile,
  type ValidPlan,
} from "./plan.ts";
import type {
  Applied,
  CarriedRef,
  Coverage,
  Diff,
  FileCoverage,
  LockToken,
  PlanFile,
  PlanVersion,
  RepoPath,
  Review,
  ReviewMode,
  SessionAnchor,
  SessionComment,
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
  /** Where every review goes, whatever its mode: reviews/. */
  reviewsDir(): string;
  /** Every reviews/vN.json. Files from before walk reviews had their own slot can be walk reviews. */
  reviews(): StoredReview[];
  /** reviews/walk/vN.json, plus older walk reviews stored as reviews/vN.json. */
  walkReviews(): StoredReview[];
  /** The split-mode review with the highest version, or null. Walk reviews never feed the planner. */
  lastReview(): Review | null;
  /**
   * The latest review of this mode below `before` (any version when null): the finished one, or
   * the autosave of an unfinished review at a higher version. During the live loop the comments
   * only exist in that autosave, and a plan answering them must still validate against them.
   */
  priorReview(mode: ReviewMode, before: PlanVersion | null): Review | null;
  readDraft(): unknown;
  writeDraft(draft: unknown): void;
  writePrompt(text: string): void;
  /** Written once per plan version and mode; a second write to the same slot throws. */
  writeReview(review: Review): void;
  /** Writes plans/vN.json unless the latest plan has the same hash. */
  freeze(plan: ValidPlan): PlanVersion;
  applied(): Applied | null;
  /** coverage.json, the agent's last test run at the tip, or null before the first. */
  coverage(): Coverage | null;
  writeCoverage(coverage: Coverage): void;
  /** Removes coverage.json, so the next run, per-test ones included, starts fresh. */
  clearCoverage(): void;
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

function coveragePath(dir: string): string {
  return join(dir, "coverage.json");
}

/** The coverage.json of the session in `dir`, or null when there is none. */
export function readCoverageIn(dir: string): Coverage | null {
  const path = coveragePath(dir);
  const raw = readJson(path);
  if (raw === undefined) return null;
  const coverage = parseCoverage(raw);
  if (typeof coverage === "string") throw new SessionFileError(`${path}: ${coverage}`);
  return coverage;
}

/**
 * What the report counts: the files of the session's test run that still describe `tip`. Null
 * without a run, and when coverage.json cannot be read, so a report never fails on it.
 */
export async function coverageAt(
  repo: string,
  dir: string,
  tip: Sha,
): Promise<ReadonlyMap<RepoPath, FileCoverage> | null> {
  let coverage: Coverage | null;
  try {
    coverage = readCoverageIn(dir);
  } catch (error) {
    if (error instanceof SessionFileError) return null;
    throw error;
  }
  return coverage === null ? null : freshFiles(coverage, await staleFiles(repo, coverage, tip));
}

function makeSession(root: string, dir: string, anchor: SessionAnchor, diff: Diff): Session {
  const plansDir = join(dir, "plans");
  const splitReviews = join(dir, "reviews");
  // Older builds wrote reviewer reviews to reviews/walk/; they stay readable, nothing new goes there.
  const legacyWalkDir = join(splitReviews, "walk");
  const reviewsDir = (): string => splitReviews;
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

  const reviewsIn = (dir: string): StoredReview[] =>
    versions(dir).map(({ version, path }) => {
      const review = parseReview(readJson(path));
      if (typeof review === "string") throw new SessionFileError(`${path}: ${review}`);
      return { version, review };
    });
  const reviews = (): StoredReview[] => reviewsIn(splitReviews);
  const walkReviews = (): StoredReview[] =>
    [...reviews().filter((r) => r.review.mode === "walk"), ...reviewsIn(legacyWalkDir)].sort(
      (a, b) => a.version - b.version,
    );

  const draftVersions = (): PlanVersion[] => {
    const dir = reviewsDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir).flatMap((name) => {
      const n = Number(/^v([1-9][0-9]*)\.draft\.json$/.exec(name)?.[1]);
      return isPlanVersion(n) ? [n] : [];
    });
  };
  const draftReview = (mode: ReviewMode, version: PlanVersion): Review => {
    const path = join(reviewsDir(), `v${version}.draft.json`);
    const draft = parseDraft(readJson(path));
    if (typeof draft === "string") throw new SessionFileError(`${path}: ${draft}`);
    const { comments, concerns, resolved, excluded } = draft;
    return {
      schema: "follow-me/review@1",
      mode,
      planVersion: version,
      planHash: plans().find((p) => p.version === version)?.hash ?? "",
      endedAt: statSync(path).mtime.toISOString(),
      comments,
      ...(concerns.length === 0 ? {} : { concerns }),
      ...(resolved.length === 0 ? {} : { resolved }),
      ...(excluded.comments.length + excluded.concerns.length === 0 ? {} : { excluded }),
    };
  };
  const priorReview = (mode: ReviewMode, before: PlanVersion | null): Review | null => {
    const below = (v: PlanVersion) => before === null || v < before;
    const done = (mode === "walk" ? walkReviews() : reviews().filter((r) => r.review.mode === mode))
      .filter((r) => below(r.version))
      .at(-1);
    const unfinished = draftVersions()
      .filter((v) => below(v) && v > (done?.version ?? 0))
      .sort((a, b) => a - b)
      .at(-1);
    if (unfinished === undefined) return done?.review ?? null;
    // A draft answers comments from every earlier version, so the finished review's
    // comments stay visible beside the newer autosave's.
    const current = draftReview(mode, unfinished);
    if (done === undefined) return current;
    const seen = new Set(current.comments.map((c) => c.id));
    const earlier = done.review.comments.filter((c) => !seen.has(c.id));
    return { ...current, comments: [...earlier, ...current.comments] };
  };

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
    lastReview: () => priorReview("split", null),
    priorReview,
    readDraft: () => {
      const draft = readJson(draftPath);
      if (draft === undefined) throw new MissingDraftError(draftPath);
      return draft;
    },
    writeDraft: (draft) => writeJson(draftPath, draft),
    writePrompt: (text) => writeText(promptPath, text),
    writeReview: (review) => {
      const path = join(reviewsDir(), `v${review.planVersion}.json`);
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
    coverage: () => readCoverageIn(dir),
    writeCoverage: (coverage) => writeJson(coveragePath(dir), serializeCoverage(coverage)),
    clearCoverage: () => rmSync(coveragePath(dir), { force: true }),
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

/**
 * The diff a stored plan was made on: the session's own when the plan is for this tip, else the
 * plan's base and tip loaded again. Null when those commits are gone from the repo.
 */
export async function diffOfPlan(session: Session, plan: StoredPlan): Promise<Diff | null> {
  const { base, tip } = plan.file;
  if (base === session.anchor.base && tip === session.anchor.tip) return session.diff;
  try {
    return await loadDiff(session.root, base, tip);
  } catch (error) {
    if (error instanceof GitError) return null;
    throw error;
  }
}

/**
 * How the latest plan carries over to the branch as it is now, or null when that plan was made
 * for this tip. The old diff is loaded from the plan's own base and tip, so this gives the same
 * answer however many times it runs after the move.
 */
export async function sinceLastPlan(
  session: Session,
): Promise<(Evolution & { readonly since: PlanVersion }) | null> {
  const latest = session.plans().at(-1);
  if (latest === undefined || latest.file.tip === session.anchor.tip) return null;
  const oldDiff = await loadDiff(session.root, latest.file.base, latest.file.tip);
  return { since: latest.version, ...evolvePlan(latest.file, oldDiff, session.diff) };
}

/**
 * Pure. The comments a review's `carried` names, whole, from the reviews that hold them: each
 * from the review of its version, its thread completed with the replies later versions stored
 * as earlierReplies. `reviews` are the session's reviews up to the one asking; a ref whose review
 * is missing is skipped, so a damaged session still reports the rest.
 */
export function sessionComments(
  refs: readonly CarriedRef[],
  reviews: readonly Review[],
): SessionComment[] {
  return refs.flatMap(({ comment: id, ...at }) => {
    const comment = reviews
      .find((r) => r.planVersion === at.version)
      ?.comments.find((c) => c.id === id);
    if (comment === undefined) return [];
    const later = reviews
      .filter((r) => r.planVersion > at.version)
      .sort((a, b) => a.planVersion - b.planVersion)
      .flatMap((r) => (r.earlierReplies ?? []).filter((e) => e.comment === id))
      .flatMap((e) => e.replies);
    const seen = new Set((comment.replies ?? []).map((r) => r.id));
    const replies = [...(comment.replies ?? []), ...later.filter((r) => !seen.has(r.id))];
    return [{ ...at, comment: replies.length === 0 ? comment : { ...comment, replies } }];
  });
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
