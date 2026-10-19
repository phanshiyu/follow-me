import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/follow-me.ts", import.meta.url));
const SKILL = fileURLToPath(new URL("../skills/follow-me/SKILL.md", import.meta.url));

function sandbox(t: TestContext) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "follow-me-home-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "follow-me-repo-")));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const cli = (verb: string, args: string[]) => {
    const r = spawnSync(BIN, [verb, ...args], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const run = (...args: string[]) => cli("install", args);
  const uninstall = (...args: string[]) => cli("uninstall", args);
  return { home, repo, run, uninstall };
}

test("install --project writes detected harnesses into the repo, then reports unchanged", (t) => {
  const { home, repo, run } = sandbox(t);
  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, ".codex"));
  const claude = join(repo, ".claude/skills/follow-me/SKILL.md");
  const agents = join(repo, ".agents/skills/follow-me/SKILL.md");

  const first = run("--project");
  assert.equal(first.code, 0, first.err);
  assert.deepEqual(first.out.trim().split("\n"), [`wrote ${claude}`, `wrote ${agents}`]);
  assert.equal(readFileSync(claude, "utf8"), readFileSync(SKILL, "utf8"));
  assert.equal(readFileSync(agents, "utf8"), readFileSync(SKILL, "utf8"));
  assert.equal(existsSync(join(repo, ".cursor")), false);

  const second = run("--project");
  assert.deepEqual(second.out.trim().split("\n"), [`unchanged ${claude}`, `unchanged ${agents}`]);
});

test("the default scope is HOME, and --dry-run writes nothing", (t) => {
  const { home, repo, run } = sandbox(t);
  const dry = run("--harness", "opencode,copilot", "--dry-run");
  const opencode = join(home, ".config/opencode/skills/follow-me/SKILL.md");
  const copilot = join(home, ".copilot/skills/follow-me/SKILL.md");
  assert.deepEqual(dry.out.trim().split("\n"), [
    `would write ${opencode}`,
    `would write ${copilot}`,
  ]);
  assert.equal(existsSync(opencode), false);

  assert.equal(run("--harness", "opencode,copilot").code, 0);
  assert.equal(readFileSync(copilot, "utf8"), readFileSync(SKILL, "utf8"));
  assert.equal(existsSync(join(repo, ".github")), false);
});

test("--all shares one file between harnesses with the same directory", (t) => {
  const { run } = sandbox(t);
  const r = run("--all");
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim().split("\n").length, 6);
});

test("install fails clearly with nothing detected or an unknown harness", (t) => {
  const { run } = sandbox(t);
  const none = run();
  assert.equal(none.code, 1);
  assert.match(none.err, /no harness config directory found/);
  const bad = run("--harness", "emacs");
  assert.equal(bad.code, 1);
  assert.match(bad.err, /unknown harness "emacs"/);
});

test("--list prints every harness with paths and docs", (t) => {
  const { run } = sandbox(t);
  const r = run("--list");
  assert.equal(r.code, 0);
  assert.match(r.out, /cursor {2}Cursor\n {2}project {2}\.cursor\/skills\/follow-me\/SKILL\.md\n/);
  assert.match(r.out, /docs {5}https:\/\/geminicli\.com\/docs\/cli\/skills\//);
});

test("uninstall --project removes what install wrote in the repo, then reports absent", (t) => {
  const { home, repo, run, uninstall } = sandbox(t);
  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, ".codex"));
  const claude = join(repo, ".claude/skills/follow-me/SKILL.md");
  const agents = join(repo, ".agents/skills/follow-me/SKILL.md");
  assert.equal(run("--project").code, 0);

  const first = uninstall("--project");
  assert.equal(first.code, 0, first.err);
  assert.deepEqual(first.out.trim().split("\n"), [`removed ${claude}`, `removed ${agents}`]);
  assert.deepEqual(readdirSync(join(repo, ".claude/skills")), []);
  assert.deepEqual(readdirSync(join(repo, ".agents/skills")), []);

  const second = uninstall("--project");
  assert.deepEqual(second.out.trim().split("\n"), [`absent ${claude}`, `absent ${agents}`]);
});

test("uninstall --dry-run removes nothing, and a folder with other files stays", (t) => {
  const { home, run, uninstall } = sandbox(t);
  assert.equal(run("--harness", "opencode,copilot").code, 0);
  const opencode = join(home, ".config/opencode/skills/follow-me/SKILL.md");
  const copilot = join(home, ".copilot/skills/follow-me/SKILL.md");
  const mine = join(home, ".copilot/skills/follow-me/notes.md");
  writeFileSync(mine, "mine\n");

  const dry = uninstall("--harness", "opencode,copilot", "--dry-run");
  assert.deepEqual(dry.out.trim().split("\n"), [
    `would remove ${opencode}`,
    `would remove ${copilot}`,
  ]);
  assert.equal(existsSync(opencode), true);

  const real = uninstall("--harness", "opencode,copilot");
  assert.deepEqual(real.out.trim().split("\n"), [`removed ${opencode}`, `removed ${copilot}`]);
  assert.deepEqual(readdirSync(join(home, ".config/opencode/skills")), []);
  assert.deepEqual(readdirSync(join(home, ".copilot/skills/follow-me")), ["notes.md"]);
});

test("uninstall --all visits every distinct file once", (t) => {
  const { home, run, uninstall } = sandbox(t);
  assert.equal(run("--harness", "cursor").code, 0);
  const r = uninstall("--all");
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trim().split("\n");
  assert.equal(lines.length, 6);
  assert.deepEqual(
    lines.filter((line) => !line.startsWith("absent ")),
    [`removed ${join(home, ".cursor/skills/follow-me/SKILL.md")}`],
  );
});

test("uninstall fails clearly with nothing detected or an unknown harness", (t) => {
  const { uninstall } = sandbox(t);
  const none = uninstall();
  assert.equal(none.code, 1);
  assert.match(none.err, /no harness config directory found/);
  const bad = uninstall("--harness", "emacs");
  assert.equal(bad.code, 1);
  assert.match(bad.err, /unknown harness "emacs"/);
});
