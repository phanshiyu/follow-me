import { execFile } from "node:child_process";
import { isSha, neededBlobs, parseDiff } from "./diff.ts";
import type { Diff, Sha } from "./types.ts";

export class GitError extends Error {
  override readonly name = "GitError";
  readonly args: readonly string[];
  constructor(args: readonly string[], stderr: string) {
    super(`git ${args.join(" ")}: ${stderr}`);
    this.args = args;
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
        if (error) reject(new GitError(args, stderr.toString("utf8").trim() || error.message));
        else resolve(stdout);
      },
    );
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

export async function defaultBaseRef(repo: string): Promise<string> {
  for (const name of ["main", "master"]) {
    if ((await resolveOptional(repo, `refs/heads/${name}`)) !== null) return name;
  }
  throw new Error("neither main nor master exists; pass --base <ref>");
}

async function catBlobs(repo: string, shas: readonly Sha[]): Promise<Map<Sha, string>> {
  const blobs = new Map<Sha, string>();
  if (shas.length === 0) return blobs;
  const out = await git(repo, ["cat-file", "--batch"], { input: `${shas.join("\n")}\n` });
  let at = 0;
  for (const sha of shas) {
    const nl = out.indexOf(0x0a, at);
    const header = out.subarray(at, nl).toString("latin1");
    const m = /^([0-9a-f]+) blob (\d+)$/.exec(header);
    if (nl === -1 || m === null || m[1] !== sha) {
      throw new Error(`cat-file returned "${header}" for ${sha}`);
    }
    const size = Number(m[2]);
    blobs.set(sha, out.subarray(nl + 1, nl + 1 + size).toString("latin1"));
    at = nl + 1 + size + 1;
  }
  return blobs;
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
