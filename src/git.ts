import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { isRepoPath, isSha, neededBlobs, parseDiff } from "./diff.ts";
import type { ValidPlan } from "./plan.ts";
import type { Diff, RepoPath, Sha, TreeChange } from "./types.ts";

export class GitError extends Error {
  override readonly name = "GitError";
  readonly args: readonly string[];
  /** git's exit status, or null when it did not run or was killed. */
  readonly status: number | null;
  constructor(args: readonly string[], stderr: string, status: number | null = null) {
    super(`git ${args.join(" ")}: ${stderr}`);
    this.args = args;
    this.status = status;
  }
}

type RunOptions = { readonly input?: Buffer | string; readonly env?: Record<string, string> };

function git(repo: string, args: readonly string[], opts: RunOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      {
        cwd: repo,
        encoding: "buffer",
        maxBuffer: 1 << 30,
        env: { ...process.env, ...opts.env },
      },
      (error, stdout, stderr) => {
        if (error) {
          const status = typeof error.code === "number" ? error.code : null;
          reject(new GitError(args, stderr.toString("utf8").trim() || error.message, status));
        } else resolve(stdout);
      },
    );
    // git can exit before reading its input (a bad ref, a missing repo). On Linux the
    // pending write then fails with EPIPE; the callback above already carries git's
    // real error, so that write failure is noise.
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin?.end(opts.input ?? "");
  });
}

async function gitText(repo: string, args: readonly string[], opts?: RunOptions): Promise<string> {
  return (await git(repo, args, opts)).toString("utf8").trim();
}

function toSha(s: string, what: string): Sha {
  if (!isSha(s)) throw new Error(`expected an object id for ${what}, got "${s}"`);
  return s;
}

export async function resolveCommit(repo: string, ref: string): Promise<Sha> {
  return toSha(
    await gitText(repo, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]),
    ref,
  );
}

async function resolveOptional(repo: string, ref: string): Promise<Sha | null> {
  try {
    return toSha(
      await gitText(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", ref]),
      ref,
    );
  } catch (error) {
    if (error instanceof GitError) return null;
    throw error;
  }
}

/** The ref refs/heads/<name> points at, or null when there is no such branch. */
export function branchHead(repo: string, name: string): Promise<Sha | null> {
  return resolveOptional(repo, `refs/heads/${name}`);
}

export async function treeOf(repo: string, rev: string): Promise<Sha> {
  return toSha(
    await gitText(repo, ["rev-parse", "--verify", "--end-of-options", `${rev}^{tree}`]),
    `${rev}^{tree}`,
  );
}

export async function repoRoot(repo: string): Promise<string> {
  return gitText(repo, ["rev-parse", "--show-toplevel"]);
}

export async function currentBranch(repo: string): Promise<string | null> {
  try {
    return await gitText(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  } catch (error) {
    if (error instanceof GitError) return null;
    throw error;
  }
}

/** Each branch checked out in some worktree of the repo, mapped to that worktree's path. */
export async function checkedOutBranches(repo: string): Promise<Map<string, string>> {
  const out = (await git(repo, ["worktree", "list", "--porcelain", "-z"])).toString("utf8");
  const found = new Map<string, string>();
  let path = "";
  for (const field of out.split("\0")) {
    if (field.startsWith("worktree ")) path = field.slice("worktree ".length);
    if (field.startsWith("branch refs/heads/"))
      found.set(field.slice("branch refs/heads/".length), path);
  }
  return found;
}

export async function branchExists(repo: string, name: string): Promise<boolean> {
  return (await branchHead(repo, name)) !== null;
}

export async function defaultBaseRef(repo: string): Promise<string> {
  for (const name of ["main", "master"]) {
    if ((await resolveOptional(repo, `refs/heads/${name}`)) !== null) return name;
  }
  throw new Error("neither main nor master exists; pass --base <ref>");
}

/** The blob named by each object spec, in order, as latin1; throws when one is not a blob. */
async function catBatch(repo: string, specs: readonly string[]): Promise<string[]> {
  if (specs.length === 0) return [];
  const input = Buffer.from(`${specs.join("\n")}\n`, "latin1");
  const out = await git(repo, ["cat-file", "--batch"], { input });
  const blobs: string[] = [];
  let at = 0;
  for (const spec of specs) {
    const nl = out.indexOf(0x0a, at);
    const header = out.subarray(at, nl).toString("latin1");
    const m = /^([0-9a-f]+) blob (\d+)$/.exec(header);
    if (nl === -1 || m === null || (isSha(spec) && m[1] !== spec)) {
      throw new Error(`cat-file returned "${header}" for ${spec}`);
    }
    const size = Number(m[2]);
    blobs.push(out.subarray(nl + 1, nl + 1 + size).toString("latin1"));
    at = nl + 1 + size + 1;
  }
  return blobs;
}

async function catBlobs(repo: string, shas: readonly Sha[]): Promise<Map<Sha, string>> {
  const blobs = await catBatch(repo, shas);
  return new Map(shas.map((sha, i) => [sha, blobs[i] ?? ""]));
}

/** Each path's bytes at the commit, as latin1. */
export async function blobsAt(
  repo: string,
  commit: Sha,
  paths: readonly RepoPath[],
): Promise<Map<RepoPath, string>> {
  const blobs = await catBatch(
    repo,
    paths.map((p) => `${commit}:${p}`),
  );
  return new Map(paths.map((p, i) => [p, blobs[i] ?? ""]));
}

function pathList(out: Buffer): Set<RepoPath> {
  return new Set(
    out
      .toString("latin1")
      .split("\0")
      .filter((p) => isRepoPath(p)),
  );
}

/** Every file path in the commit's tree. */
export async function pathsAt(repo: string, commit: Sha): Promise<Set<RepoPath>> {
  return pathList(await git(repo, ["ls-tree", "-r", "-z", "--name-only", commit]));
}

/**
 * Paths whose content differs between the commit and `to`: another commit, or with null the
 * working tree and index. Untracked files are not listed.
 */
export async function pathsChanged(
  repo: string,
  from: Sha,
  to: Sha | null,
): Promise<Set<RepoPath>> {
  const target = to === null ? [] : [to];
  return pathList(
    await git(repo, ["diff", "--name-only", "-z", ...DIFF_FLAGS, from, ...target, "--"]),
  );
}

export type GrepMatch = { readonly path: RepoPath; readonly line: number; readonly text: string };

/**
 * Lines of the commit's tree, not the working tree, that match any of the POSIX extended
 * patterns, in files matching the pathspecs. Binary files are skipped.
 */
export async function grepTip(
  repo: string,
  commit: Sha,
  patterns: readonly string[],
  pathspecs: readonly string[],
): Promise<GrepMatch[]> {
  const args = [
    "grep",
    "-n",
    "-E",
    "-I",
    "-z",
    "--no-color",
    "--no-column",
    ...patterns.flatMap((p) => ["-e", p]),
    commit,
    "--",
    ...pathspecs,
  ];
  let out: Buffer;
  try {
    out = await git(repo, args);
  } catch (error) {
    // grep exits 1 when nothing matched.
    if (error instanceof GitError && error.status === 1) return [];
    throw error;
  }
  const prefix = `${commit}:`;
  return out
    .toString("latin1")
    .split("\n")
    .flatMap((record) => {
      const [name = "", line = "", ...text] = record.split("\0");
      const path = name.slice(prefix.length);
      if (!name.startsWith(prefix) || !isRepoPath(path) || !/^\d+$/.test(line)) return [];
      return [{ path, line: Number(line), text: text.join("\0") }];
    });
}

const DIFF_FLAGS = ["--no-renames", "--full-index", "--no-color", "--no-ext-diff", "--no-textconv"];

export async function loadDiff(repo: string, baseRef: string, tipRef: string): Promise<Diff> {
  const [tip, baseCommit] = await Promise.all([
    resolveCommit(repo, tipRef),
    resolveCommit(repo, baseRef),
  ]);
  const base = toSha(await gitText(repo, ["merge-base", baseCommit, tip]), "merge-base");
  const [baseTree, tipTree, raw, patch] = await Promise.all([
    treeOf(repo, base),
    treeOf(repo, tip),
    git(repo, ["diff", "--raw", "-z", "--no-abbrev", ...DIFF_FLAGS, base, tip]),
    git(repo, ["diff", "-U3", ...DIFF_FLAGS, base, tip]),
  ]);
  const rawZ = raw.toString("latin1");
  const patchText = patch.toString("latin1");
  const blobs = await catBlobs(repo, neededBlobs(rawZ, patchText));
  return parseDiff({ base, tip, baseTree, tipTree, rawZ, patch: patchText, blobs });
}

/**
 * Whether the configured user wrote every commit of base..tip, which is how follow-me tells its
 * author's own branch from one it is asked to review. False when no user.email is set.
 */
export async function isOwnWork(repo: string, base: Sha, tip: Sha): Promise<boolean> {
  const me = await gitText(repo, ["config", "--default=", "user.email"]);
  if (me === "") return false;
  const authors = await gitText(repo, ["log", "--format=%ae", `${base}..${tip}`]);
  const emails = authors.split("\n").filter((line) => line !== "");
  return emails.length > 0 && emails.every((email) => email === me);
}

/** "config" leaves signing to commit.gpgsign; "on" and "off" override it. */
export type SignMode = "config" | "on" | "off";

/** Whether commits written in this mode are signed, and with which gpg.format. */
export type Signing = { readonly on: boolean; readonly format: string };

export async function signing(repo: string, mode: SignMode): Promise<Signing> {
  const configured = await gitText(repo, [
    "config",
    "--type=bool",
    "--default=false",
    "commit.gpgsign",
  ]);
  const format = await gitText(repo, ["config", "--default=openpgp", "gpg.format"]);
  const on = mode === "config" ? configured === "true" : mode === "on";
  return { on, format };
}

export type WriteResult = {
  readonly kind: "created" | "updated" | "unchanged";
  readonly branch: string;
  readonly head: Sha;
  readonly commits: readonly Sha[];
};

export class BranchRefusedError extends Error {
  override readonly name = "BranchRefusedError";
}

type Identity = {
  readonly name: string;
  readonly email: string;
  readonly time: number;
  readonly tz: string;
};

async function identities(
  repo: string,
  commit: Sha,
): Promise<{ author: Identity; committer: Identity }> {
  const text = await gitText(repo, ["cat-file", "commit", commit]);
  const find = (role: string): Identity => {
    const m = new RegExp(`^${role} (.*) <(.*)> (\\d+) ([+-]\\d{4})$`, "m").exec(text);
    if (m === null) throw new Error(`commit ${commit} has no readable ${role} line`);
    return { name: m[1] ?? "", email: m[2] ?? "", time: Number(m[3]), tz: m[4] ?? "+0000" };
  };
  return { author: find("author"), committer: find("committer") };
}

function identityEnv(who: { author: Identity; committer: Identity }, back: number) {
  const date = (i: Identity) => `@${i.time - back} ${i.tz}`;
  return {
    GIT_AUTHOR_NAME: who.author.name,
    GIT_AUTHOR_EMAIL: who.author.email,
    GIT_AUTHOR_DATE: date(who.author),
    GIT_COMMITTER_NAME: who.committer.name,
    GIT_COMMITTER_EMAIL: who.committer.email,
    GIT_COMMITTER_DATE: date(who.committer),
  };
}

async function indexLine(
  repo: string,
  change: TreeChange,
  zero: string,
  env: Record<string, string>,
): Promise<Buffer> {
  const entry = async (): Promise<string> => {
    if (change.op === "delete") return `0 ${zero}`;
    if (change.op === "link") return `${change.entry.mode} ${change.entry.blob}`;
    const blob = await gitText(repo, ["hash-object", "-w", "--stdin"], {
      input: Buffer.from(change.bytes, "latin1"),
      env,
    });
    return `${change.mode} ${toSha(blob, change.path)}`;
  };
  return Buffer.concat([
    Buffer.from(`${await entry()}\t`),
    Buffer.from(change.path, "latin1"),
    Buffer.from([0]),
  ]);
}

/** Prefix of the quarantine directories writeBranch creates inside the object store. */
export const QUARANTINE_PREFIX = "follow-me-incoming-";

export async function objectsDir(repo: string): Promise<string> {
  return gitText(repo, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]);
}

/** Hard-links the quarantined loose objects into the store; an object already there stays. */
async function adoptObjects(quarantine: string, objects: string): Promise<void> {
  for (const fanout of await readdir(quarantine)) {
    if (!/^[0-9a-f]{2}$/.test(fanout)) continue;
    await mkdir(join(objects, fanout), { recursive: true });
    for (const name of await readdir(join(quarantine, fanout))) {
      if (name.startsWith("tmp_")) continue;
      try {
        await link(join(quarantine, fanout, name), join(objects, fanout, name));
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
    }
  }
}

/**
 * Writes the plan as commits on top of the merge-base through a temporary index, so the
 * user's index and worktree are never touched, then moves refs/heads/<name> by compare-and-swap.
 * New objects go to a quarantine inside the object store and are adopted only right before the
 * ref moves, so a refused or failed write leaves neither refs nor objects behind.
 * With opts.sign, commit-tree signs with gpg.format and user.signingkey.
 */
export async function writeBranch(
  repo: string,
  diff: Diff,
  plan: ValidPlan,
  opts: {
    readonly name: string;
    /** The branch being split. It is never written, with or without force. */
    readonly source: string;
    readonly expectedOld: Sha | null;
    readonly force: boolean;
    /** commit-tree is plumbing and ignores commit.gpgsign, so the caller resolves it. */
    readonly sign: boolean;
  },
): Promise<WriteResult> {
  const ref = `refs/heads/${opts.name}`;
  try {
    await git(repo, ["check-ref-format", ref]);
  } catch {
    throw new BranchRefusedError(`"${opts.name}" is not a valid branch name`);
  }
  if (opts.name === opts.source) {
    throw new BranchRefusedError(
      `${opts.name} is the branch being split; the split always lands on a separate branch, so pick another --name (--force does not change this)`,
    );
  }
  const worktree = (await checkedOutBranches(repo)).get(opts.name);
  if (worktree !== undefined) {
    throw new BranchRefusedError(
      `branch ${opts.name} is checked out in ${worktree}; moving it would leave that worktree out of sync, so pick another --name (--force does not change this)`,
    );
  }
  const who = await identities(repo, diff.tip);
  const zero = "0".repeat(diff.base.length);
  const n = plan.commits.length;
  const objects = await objectsDir(repo);
  const dir = await mkdtemp(join(objects, `${QUARANTINE_PREFIX}${process.pid}-`));
  const commits: Sha[] = [];
  let head = diff.base;
  let tree = diff.baseTree;
  try {
    const env = {
      GIT_INDEX_FILE: join(dir, "index"),
      GIT_OBJECT_DIRECTORY: dir,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: objects,
    };
    await git(repo, ["read-tree", diff.baseTree], { env });
    for (const commit of plan.commits) {
      // Deletes go first so a file can give way to a directory of the same name.
      const ordered = [
        ...commit.changes.filter((c) => c.op === "delete"),
        ...commit.changes.filter((c) => c.op !== "delete"),
      ];
      const lines = await Promise.all(ordered.map((c) => indexLine(repo, c, zero, env)));
      await git(repo, ["update-index", "-z", "--index-info"], { env, input: Buffer.concat(lines) });
      tree = toSha(await gitText(repo, ["write-tree"], { env }), "write-tree");
      const message = commit.message.endsWith("\n") ? commit.message : `${commit.message}\n`;
      head = toSha(
        await gitText(
          repo,
          ["commit-tree", opts.sign ? "-S" : "--no-gpg-sign", tree, "-p", head, "-F", "-"],
          {
            input: message,
            env: { ...env, ...identityEnv(who, n - 1 - commit.index) },
          },
        ),
        "commit-tree",
      );
      commits.push(head);
    }
    if (tree !== diff.tipTree) {
      throw new Error(`the last commit's tree ${tree} differs from the tip tree ${diff.tipTree}`);
    }

    const current = await branchHead(repo, opts.name);
    // Unsigned commits, and deterministic signatures such as ssh ed25519, give the same SHAs.
    if (current === head) return { kind: "unchanged", branch: opts.name, head, commits };
    if (current !== null && !opts.force) {
      if (opts.expectedOld === null) {
        throw new BranchRefusedError(
          `branch ${opts.name} already exists and follow-me did not write it; pass --force to overwrite`,
        );
      }
      if (current !== opts.expectedOld) {
        throw new BranchRefusedError(
          `branch ${opts.name} moved since the last apply (expected ${opts.expectedOld}, found ${current}); pass --force to overwrite`,
        );
      }
    }
    await adoptObjects(dir, objects);
    await git(repo, ["update-ref", "-m", "follow-me apply", ref, head, current ?? zero]);
    return { kind: current === null ? "created" : "updated", branch: opts.name, head, commits };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
