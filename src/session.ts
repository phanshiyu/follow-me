import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isRepoPath, isSha, isUnitId } from "./diff.ts";
import { currentBranch, defaultBaseRef, loadDiff, repoRoot, resolveCommit } from "./git.ts";
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
  PlanFile,
  PlanVersion,
  Review,
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
  plans(): StoredPlan[];
  reviews(): StoredReview[];
  /** The split-mode review with the highest version, or null. Walk reviews never feed the planner. */
  lastReview(): Review | null;
  readDraft(): unknown;
  writeDraft(draft: unknown): void;
  /** Written once per plan version; a second write for the same version throws. */
  writeReview(review: Review): void;
  /** Writes plans/vN.json unless the latest plan has the same hash. */
  freeze(plan: ValidPlan): PlanVersion;
  applied(): Applied | null;
  recordApplied(
    version: PlanVersion,
    result: { readonly branch: string; readonly head: Sha },
  ): void;
};

export function slugOf(branch: string): string {
  return branch.replaceAll("/", "-");
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
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
  if (!isFields<"schema" | "version" | "branch" | "head">(v)) return null;
  const { schema, version, branch, head } = v;
  if (schema !== "follow-me/applied@1" || !isPlanVersion(version)) return null;
  if (typeof branch !== "string" || typeof head !== "string" || !isSha(head)) return null;
  return { schema, version, branch, head };
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
  const reviewsDir = join(dir, "reviews");
  const draftPath = join(dir, "draft.json");
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

  const reviews = (): StoredReview[] =>
    versions(reviewsDir).map(({ version, path }) => {
      const review = parseReview(readJson(path));
      if (typeof review === "string") throw new SessionFileError(`${path}: ${review}`);
      return { version, review };
    });

  return {
    root,
    dir,
    anchor,
    diff,
    draftPath,
    plans,
    reviews,
    lastReview: () => reviews().findLast((r) => r.review.mode === "split")?.review ?? null,
    readDraft: () => {
      const draft = readJson(draftPath);
      if (draft === undefined) throw new SessionFileError(`${draftPath} does not exist yet`);
      return draft;
    },
    writeDraft: (draft) => writeJson(draftPath, draft),
    writeReview: (review) => {
      const path = join(reviewsDir, `v${review.planVersion}.json`);
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
    applied: () => {
      const raw = readJson(appliedPath);
      if (raw === undefined) return null;
      const applied = parseApplied(raw);
      if (applied === null) throw new SessionFileError(`${appliedPath} is not an applied record`);
      return applied;
    },
    recordApplied: (version, result) =>
      writeJson(appliedPath, {
        schema: "follow-me/applied@1",
        version,
        branch: result.branch,
        head: result.head,
      } satisfies Applied),
  };
}

type Where = { readonly root: string; readonly branch: string; readonly dir: string };

async function locate(repo: string, branch: string | undefined): Promise<Where> {
  const root = await repoRoot(repo);
  const name = branch ?? (await currentBranch(root));
  if (name === null) throw new Error("HEAD is detached; pass --branch <name>");
  const top = join(root, ".follow-me");
  mkdirSync(top, { recursive: true });
  const ignore = join(top, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  return { root, branch: name, dir: join(top, slugOf(name)) };
}

function readAnchor(dir: string): SessionAnchor | null {
  const path = join(dir, "session.json");
  const raw = readJson(path);
  if (raw === undefined) return null;
  const anchor = parseAnchor(raw);
  if (anchor === null) throw new SessionFileError(`${path} is not a session anchor`);
  return anchor;
}

/** Anchors the session to the branch's current tip, creating it if needed. Plans and reviews stay. */
export async function extractSession(
  repo: string,
  opts: { readonly branch?: string; readonly base?: string } = {},
): Promise<Session> {
  const where = await locate(repo, opts.branch);
  const baseRef = opts.base ?? readAnchor(where.dir)?.baseRef ?? (await defaultBaseRef(where.root));
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
  const anchor = readAnchor(where.dir);
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
