import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FixtureRepo = {
  readonly dir: string;
  readonly base: string;
  readonly branch: string;
  cleanup(): void;
};

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    },
  }).trim();
}

function write(dir: string, path: string, content: string | Buffer): void {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
}

const BASE_LIB = [
  "export function add(a, b) {",
  "  return a + b;",
  "}",
  "",
  "export function sub(a, b) {",
  "  return a - b;",
  "}",
  "",
  "export function mul(a, b) {",
  "  return a * b;",
  "}",
  "",
  "export function div(a, b) {",
  "  return a / b;",
  "}",
  "",
].join("\n");

const BRANCH_LIB = [
  "import { assertNumber } from './guard.js';",
  "",
  "export function add(a, b) {",
  "  assertNumber(a);",
  "  assertNumber(b);",
  "  return a + b;",
  "}",
  "",
  "export function sub(a, b) {",
  "  return a - b;",
  "}",
  "",
  "export function mul(a, b) {",
  "  assertNumber(a);",
  "  assertNumber(b);",
  "  return a * b;",
  "}",
  "",
  "export function div(a, b) {",
  "  if (b === 0) throw new RangeError('division by zero');",
  "  return a / b;",
  "}",
  "",
  "export function pow(a, b) {",
  "  return a ** b;",
  "}",
  "",
].join("\n");

/**
 * Builds a repo whose `feature` branch differs from `main` by every change
 * kind the splitter must handle: a multi-hunk edit, a new file, a deleted
 * file, a binary file, a mode change, a file with no trailing newline, and
 * a rename (seen as delete + add). Both refs are returned as commit SHAs.
 */
export function makeFixtureRepo(): FixtureRepo {
  const dir = mkdtempSync(join(tmpdir(), "follow-me-fixture-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    return { dir, ...buildFixture(dir), cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

function buildFixture(dir: string): { base: string; branch: string } {
  git(dir, "init", "-q", "-b", "main");
  write(dir, "src/lib.js", BASE_LIB);
  write(dir, "src/old-name.js", "export const legacy = true;\n");
  write(dir, "README.md", "# demo\n\nold intro\n");
  write(dir, "scripts/run.sh", "#!/bin/sh\necho run\n");
  write(dir, "assets/logo.bin", Buffer.from([0x00, 0x01, 0x02, 0xff]));
  write(dir, "notes.txt", "line one\nline two");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  const base = git(dir, "rev-parse", "HEAD");

  git(dir, "checkout", "-q", "-b", "feature");
  write(dir, "src/lib.js", BRANCH_LIB);
  write(
    dir,
    "src/guard.js",
    "export function assertNumber(x) {\n  if (typeof x !== 'number') throw new TypeError('not a number');\n}\n",
  );
  rmSync(join(dir, "src/old-name.js"));
  write(dir, "src/new-name.js", "export const legacy = true;\n");
  write(dir, "README.md", "# demo\n\nnew intro\n\n## usage\n\nrun it\n");
  chmodSync(join(dir, "scripts/run.sh"), 0o755);
  write(dir, "assets/logo.bin", Buffer.from([0xff, 0xfe, 0x00, 0x10, 0x20]));
  write(dir, "notes.txt", "line one\nline two\nline three");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "feature work");
  const branch = git(dir, "rev-parse", "HEAD");

  return { base, branch };
}

/**
 * Adds a commit on `feature` with the whole-file kinds the base fixture lacks: a new
 * symlink, a new empty file, a regular file turned symlink, and a new gitlink.
 * Returns the new branch SHA.
 */
export function addWholeFileKinds(repo: FixtureRepo): string {
  const { dir } = repo;
  symlinkSync("lib.js", join(dir, "src/lib-link.js"));
  write(dir, "empty.txt", "");
  rmSync(join(dir, "src/old-name.js"), { force: true });
  symlinkSync("new-name.js", join(dir, "src/old-name.js"));
  git(dir, "add", "-A");
  git(dir, "update-index", "--add", "--cacheinfo", `160000,${repo.base},vendor/sub`);
  // An empty directory reads as an unpopulated submodule, so the worktree stays clean.
  mkdirSync(join(dir, "vendor/sub"), { recursive: true });
  git(dir, "commit", "-q", "-m", "whole-file kinds");
  return git(dir, "rev-parse", "HEAD");
}
