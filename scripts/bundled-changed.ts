#!/usr/bin/env node
/**
 * Says whether the code inside the published web UI changed between two lockfiles.
 *
 * The UI build (ui/ to dist/ui/dist) bundles a few devDependencies and everything they pull in,
 * so a new version of any of them only reaches users with a new publish. Tooling (biome,
 * typescript, vite, vitest, playwright, @types/*) never ships and is ignored here.
 *
 * usage: node scripts/bundled-changed.ts <git-ref>
 *   compares package-lock.json at <git-ref> with the working tree; prints one line per change
 *   and exits 0 when something changed, 1 when nothing did, 2 on a usage or parse error.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Packages ui/src imports at runtime. Keep in step with renovate.json's "bundled UI deps". */
export const BUNDLED = [
  "@fontsource-variable/geist",
  "class-variance-authority",
  "cn",
  "dompurify",
  "lucide-react",
  "marked",
  "mermaid",
  "prismjs",
  "radix-ui",
  "react",
  "react-dom",
  "tailwindcss",
  "tw-animate-css",
];

type Entry = { version: string; deps: string[] };
type Lock = Map<string, Entry>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads the `packages` table of a package-lock.json (lockfileVersion 2 or 3). */
export function parseLock(text: string): Lock {
  const root: unknown = JSON.parse(text);
  const packages = isRecord(root) ? root["packages"] : undefined;
  if (!isRecord(packages)) throw new Error("package-lock.json has no packages table");
  const lock: Lock = new Map();
  for (const [path, entry] of Object.entries(packages)) {
    if (path === "" || !isRecord(entry)) continue;
    const version = entry["version"];
    const deps: string[] = [];
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      const table = entry[field];
      if (isRecord(table)) deps.push(...Object.keys(table));
    }
    lock.set(path, { version: typeof version === "string" ? version : "?", deps });
  }
  return lock;
}

/** Finds `dep` the way node does: nearest node_modules above `from`, up to the top level. */
function resolveDep(lock: Lock, from: string, dep: string): string | undefined {
  let base = from;
  for (;;) {
    const candidate = `${base ? `${base}/` : ""}node_modules/${dep}`;
    if (lock.has(candidate)) return candidate;
    const cut = base.lastIndexOf("/node_modules/");
    if (cut >= 0) base = base.slice(0, cut);
    else if (base.startsWith("node_modules/")) base = "";
    else return undefined;
  }
}

/** Every installed copy reachable from the bundled packages, as "name@path" to version. */
export function bundledVersions(
  lock: Lock,
  roots: readonly string[] = BUNDLED,
): Map<string, string> {
  const seen = new Map<string, string>();
  const queue: string[] = [];
  for (const name of roots) {
    const path = resolveDep(lock, "", name);
    if (path) queue.push(path);
  }
  while (queue.length > 0) {
    const path = queue.pop();
    const entry = path === undefined ? undefined : lock.get(path);
    if (path === undefined || entry === undefined || seen.has(path)) continue;
    seen.set(path, entry.version);
    for (const dep of entry.deps) {
      const next = resolveDep(lock, path, dep);
      if (next) queue.push(next);
    }
  }
  return seen;
}

/** One line per bundled copy that was added, removed or moved between the two lockfiles. */
export function bundledChanges(
  before: string,
  after: string,
  roots: readonly string[] = BUNDLED,
): string[] {
  const a = bundledVersions(parseLock(before), roots);
  const b = bundledVersions(parseLock(after), roots);
  const name = (path: string) => path.slice(path.lastIndexOf("node_modules/") + 13);
  const lines: string[] = [];
  for (const [path, version] of b) {
    const old = a.get(path);
    if (old !== version) lines.push(`${name(path)} ${old ?? "(new)"} -> ${version}`);
  }
  for (const [path, version] of a) {
    if (!b.has(path)) lines.push(`${name(path)} ${version} -> (removed)`);
  }
  return lines.sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ref = process.argv[2];
  if (!ref) {
    console.error("usage: node scripts/bundled-changed.ts <git-ref>");
    process.exit(2);
  }
  try {
    const before = execFileSync("git", ["show", `${ref}:package-lock.json`], {
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
    const after = readFileSync("package-lock.json", "utf8");
    const lines = bundledChanges(before, after);
    for (const line of lines) process.stdout.write(`${line}\n`);
    process.exit(lines.length > 0 ? 0 : 1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
