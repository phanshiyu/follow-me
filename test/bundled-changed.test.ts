import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BUNDLED, bundledChanges, bundledVersions, parseLock } from "../scripts/bundled-changed.ts";

type Pkg = { version: string; dependencies?: Record<string, string> };
const lockOf = (packages: Record<string, Pkg>) =>
  JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "x" }, ...packages } });

const base: Record<string, Pkg> = {
  "node_modules/app": { version: "1.0.0", dependencies: { leaf: "^1" } },
  "node_modules/leaf": { version: "1.0.0" },
  "node_modules/app/node_modules/leaf": { version: "0.5.0" },
  "node_modules/tool": { version: "1.0.0" },
  "node_modules/unrelated": { version: "1.0.0", dependencies: { tool: "^1" } },
};

test("a nested copy shadows the top-level one for the package that needs it", () => {
  const seen = bundledVersions(parseLock(lockOf(base)), ["app"]);
  assert.deepEqual([...seen.keys()].sort(), [
    "node_modules/app",
    "node_modules/app/node_modules/leaf",
  ]);
});

test("tooling changes are ignored, bundled and transitive changes are reported", () => {
  const before = lockOf(base);
  const tooling = lockOf({ ...base, "node_modules/tool": { version: "2.0.0" } });
  assert.deepEqual(bundledChanges(before, tooling, ["app"]), []);
  const transitive = lockOf({
    ...base,
    "node_modules/app/node_modules/leaf": { version: "0.5.1" },
  });
  assert.deepEqual(bundledChanges(before, transitive, ["app"]), ["leaf 0.5.0 -> 0.5.1"]);
  const direct = lockOf({
    ...base,
    "node_modules/app": { version: "1.1.0", dependencies: { leaf: "^1" } },
  });
  assert.deepEqual(bundledChanges(before, direct, ["app"]), ["app 1.0.0 -> 1.1.0"]);
});

test("a copy that appears or disappears counts", () => {
  const { "node_modules/app/node_modules/leaf": _, ...rest } = base;
  assert.deepEqual(bundledChanges(lockOf(base), lockOf(rest), ["app"]), [
    "leaf (new) -> 1.0.0",
    "leaf 0.5.0 -> (removed)",
  ]);
});

test("the bundled list names real devDependencies and matches renovate.json", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  for (const name of BUNDLED)
    assert.ok(name in pkg.devDependencies, `${name} is not a devDependency`);
  const renovate = JSON.parse(readFileSync("renovate.json", "utf8"));
  const rule = renovate.packageRules.find(
    (r: { groupName?: string }) => r.groupName === "bundled UI deps",
  );
  assert.deepEqual([...rule.matchPackageNames].sort(), [...BUNDLED].sort());
});

test("the real lockfile resolves every bundled root", () => {
  const seen = bundledVersions(parseLock(readFileSync("package-lock.json", "utf8")));
  for (const name of BUNDLED) assert.ok(seen.has(`node_modules/${name}`), `${name} not in lock`);
});
