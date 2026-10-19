import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/follow-me.ts", import.meta.url));
const SKILL = fileURLToPath(new URL("../skills/follow-me/SKILL.md", import.meta.url));

function sandbox() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "fm-home-")));
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "fm-repo-")));
  const run = (...args: string[]) => {
    const r = spawnSync(BIN, ["install", ...args], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  return { home, repo, run };
}

test("install writes detected harnesses at project scope, then reports unchanged", () => {
  const { home, repo, run } = sandbox();
  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, ".codex"));
  const claude = join(repo, ".claude/skills/follow-me/SKILL.md");
  const agents = join(repo, ".agents/skills/follow-me/SKILL.md");

  const first = run();
  assert.equal(first.code, 0, first.err);
  assert.deepEqual(first.out.trim().split("\n"), [`wrote ${claude}`, `wrote ${agents}`]);
  assert.equal(readFileSync(claude, "utf8"), readFileSync(SKILL, "utf8"));
  assert.equal(readFileSync(agents, "utf8"), readFileSync(SKILL, "utf8"));
  assert.equal(existsSync(join(repo, ".cursor")), false);

  const second = run();
  assert.deepEqual(second.out.trim().split("\n"), [`unchanged ${claude}`, `unchanged ${agents}`]);
});

test("--user writes under HOME and --dry-run writes nothing", () => {
  const { home, repo, run } = sandbox();
  const dry = run("--harness", "opencode,copilot", "--user", "--dry-run");
  const opencode = join(home, ".config/opencode/skills/follow-me/SKILL.md");
  const copilot = join(home, ".copilot/skills/follow-me/SKILL.md");
  assert.deepEqual(dry.out.trim().split("\n"), [
    `would write ${opencode}`,
    `would write ${copilot}`,
  ]);
  assert.equal(existsSync(opencode), false);

  assert.equal(run("--harness", "opencode,copilot", "--user").code, 0);
  assert.equal(readFileSync(copilot, "utf8"), readFileSync(SKILL, "utf8"));
  assert.equal(existsSync(join(repo, ".github")), false);
});

test("--all shares one file between harnesses with the same directory", () => {
  const { run } = sandbox();
  const r = run("--all");
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim().split("\n").length, 6);
});

test("install fails clearly with nothing detected or an unknown harness", () => {
  const { run } = sandbox();
  const none = run();
  assert.equal(none.code, 1);
  assert.match(none.err, /no harness config directory found/);
  const bad = run("--harness", "emacs");
  assert.equal(bad.code, 1);
  assert.match(bad.err, /unknown harness "emacs"/);
});

test("--list prints every harness with paths and docs", () => {
  const { run } = sandbox();
  const r = run("--list");
  assert.equal(r.code, 0);
  assert.match(r.out, /cursor {2}Cursor\n {2}project {2}\.cursor\/skills\/follow-me\/SKILL\.md\n/);
  assert.match(r.out, /docs {5}https:\/\/geminicli\.com\/docs\/cli\/skills\//);
});
