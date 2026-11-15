import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
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
import { test } from "node:test";

// These tests read the workflows as text and pin the rules that keep a release safe (docs/decisions.tsv, "publish in
// four jobs"). A rule that lives only in a comment is one edit from being lost.

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const workflowFiles = readdirSync(new URL(".github/workflows/", root)).filter((f) =>
  f.endsWith(".yml"),
);
const workflows = Object.fromEntries(workflowFiles.map((f) => [f, read(`.github/workflows/${f}`)]));
const actions = { "setup/action.yml": read(".github/actions/setup/action.yml") };
const publish = workflows["publish.yml"] ?? "";
const setupAction = actions["setup/action.yml"];

/** Each job's text, by name: the lines from "  name:" under jobs to the next job. */
function jobsOf(text: string): Record<string, string> {
  const body = text.slice(text.indexOf("\njobs:\n"));
  const jobs: Record<string, string> = {};
  for (const chunk of body.split(/\n(?= {2}[\w-]+:\n)/).slice(1)) {
    const name = chunk.match(/^ {2}([\w-]+):/)?.[1];
    if (name) jobs[name] = chunk;
  }
  return jobs;
}
const jobs = jobsOf(publish);
const job = (name: string) => {
  const text = jobs[name];
  assert.ok(text, `publish.yml has no job ${name}`);
  return text;
};
const names = (pattern: RegExp, from: Record<string, string> = jobs) =>
  Object.entries(from)
    .filter(([, text]) => pattern.test(text))
    .map(([name]) => name);

test("publish.yml is four jobs, each with a timeout", () => {
  assert.deepEqual(Object.keys(jobs), ["decide", "build", "push", "publish"]);
  for (const [name, text] of Object.entries(jobs)) assert.match(text, /timeout-minutes: \d+/, name);
});

test("only the push job writes, only the publish job holds the id-token, and neither runs repository code", () => {
  assert.deepEqual(names(/contents: write/), ["push"]);
  assert.deepEqual(names(/id-token: write/), ["publish"]);
  for (const name of ["push", "publish"]) {
    const text = job(name);
    assert.doesNotMatch(text, /actions\/checkout@/, `${name} checks out the repository`);
    assert.doesNotMatch(text, /uses: \.\//, `${name} runs a local action`);
    assert.doesNotMatch(
      text,
      /\bnpm (ci|install|run|test|version)\b/,
      `${name} installs or builds`,
    );
  }
  // The job that installs and builds holds no write access, and neither does the one that decides.
  for (const name of ["decide", "build"]) {
    assert.doesNotMatch(job(name), /(contents|id-token|actions|issues): write/, name);
  }
  assert.match(job("build"), /uses: \.\/\.github\/actions\/setup/);
  assert.match(publish, /\npermissions:\n {2}contents: read\n/);
});

test("the push job takes only the version lines from the build, and pushes commit and tag together", () => {
  const push = job("push");
  assert.match(push, /git push --atomic origin HEAD:refs\/heads\/main "refs\/tags\/v\$VERSION"/);
  assert.match(push, /The build changed more than package\.json and package-lock\.json/);
  assert.match(push, /The build changed more than version lines/);
  assert.match(push, /chore\(release\): v\$VERSION/);
});

test("the publish job publishes the tarball the build packed, checks its version, and gives npm five minutes", () => {
  const text = job("publish");
  assert.match(text, /environment: prod/);
  assert.match(text, /needs: \[decide, build, push\]/);
  assert.match(text, /the tarball is \$packed but the build reported \$VERSION/);
  assert.match(text, /timeout-minutes: 5\n\s+run: npm publish "\$RUNNER_TEMP"\/release\/\*\.tgz/);
  assert.doesNotMatch(text, /--ignore-scripts/);
});

test("the build job refuses a tag that does not match package.json, then runs every gate", () => {
  const text = job("build");
  assert.match(text, /tag v\$tag but package\.json says \$version/);
  for (const gate of ["lint", "typecheck", "build", "ui:test", "test"]) {
    assert.match(text, new RegExp(`- run: npm (run )?${gate}\\n`), gate);
  }
  assert.match(text, /npm version patch --no-git-tag-version/);
});

test("a manual start releases only the head of main, and only the push of a tag publishes a tag", () => {
  assert.match(publish, /\n {2}workflow_dispatch:\n/);
  assert.doesNotMatch(publish, /workflow_dispatch:\n\s+inputs:/);
  const script = decideScript();
  assert.match(script, /\[ "\$EVENT" = push \] && \[ "\$REF_TYPE" = tag \]/);
  assert.match(script, /\[ "\$REF" != refs\/heads\/main \]/);
});

test("no cache is restored or saved in any publishing job, nor through the setup action", () => {
  assert.doesNotMatch(publish, /actions\/cache(\/\w+)?@/);
  assert.doesNotMatch(publish, /^\s+cache(-dependency-path)?: (?!'false')/m);
  assert.doesNotMatch(publish, /cache-dependency-path/);
  // The setup action caches npm's downloads unless told not to, so a caller that publishes passes cache: 'false'.
  assert.match(setupAction, /cache: \$\{\{ inputs\.cache == 'true' && 'npm' \|\| '' \}\}/);
  assert.match(setupAction, /package-manager-cache: \$\{\{ inputs\.cache == 'true' \}\}/);
  assert.match(setupAction, /inputs:[\s\S]*\n {2}cache:\n[\s\S]*default: 'true'/);
  assert.doesNotMatch(setupAction, /actions\/cache/);
  for (const step of publish.split(/\n(?=\s+- )/)) {
    if (/uses: \.\/\.github\/actions\/setup/.test(step)) assert.match(step, /cache: 'false'/);
    // setup-node turns a cache on by itself for some projects, so every use says no.
    if (/uses: actions\/setup-node@/.test(step)) assert.match(step, /package-manager-cache: false/);
  }
  assert.ok(names(/actions\/setup-node@|uses: \.\/\.github\/actions\/setup/).length >= 3);
});

test("every workflow: actions pinned by digest with a version, least privilege, no expression in a script", () => {
  assert.ok(workflowFiles.length >= 3);
  const files = { ...workflows, ...Object.fromEntries(Object.entries(actions)) };
  for (const [file, text] of Object.entries(files)) {
    for (const line of text.split("\n")) {
      const use = line.match(/^\s+(?:- )?uses: (\S+)(.*)$/);
      if (!use || use[1]?.startsWith("./")) continue;
      assert.match(use[1] ?? "", /^[\w-]+\/[\w./-]+@[0-9a-f]{40}$/, `${file}: ${line.trim()}`);
      assert.match(use[2] ?? "", /^ # v\d+(\.\d+)*$/, `${file}: ${line.trim()}`);
    }
  }
  for (const [file, text] of Object.entries(workflows)) {
    assert.match(text, /\npermissions:\n {2}contents: read\n/, `${file} has no read-only default`);
    for (const [name, body] of Object.entries(jobsOf(text))) {
      assert.match(body, /timeout-minutes: \d+/, `${file} ${name}`);
    }
    const runs = text.match(/^ +(?:- )?run: (?:[|>]-?\n(?: {8,}.*\n?|\n)+|.*)/gm) ?? [];
    assert.ok(runs.length > 0, file);
    for (const run of runs) {
      // An expression in a script is code injection when it holds event data; only the build's own values pass.
      const bad = (run.match(/\$\{\{[^}]*\}\}/g) ?? []).filter(
        (e) => !/^\$\{\{ *(matrix\.node|runner\.temp) *\}\}$/.test(e),
      );
      assert.deepEqual(bad, [], `${file}: ${run.slice(0, 60)}`);
    }
  }
});

test("ci-ok needs every other job and passes only when all of them did", () => {
  const ci = workflows["ci.yml"] ?? "";
  const all = jobsOf(ci);
  const others = Object.keys(all).filter((name) => name !== "ci-ok");
  assert.ok(others.length >= 4);
  const needs = all["ci-ok"]
    ?.match(/needs: \[([^\]]*)\]/)?.[1]
    ?.split(/,\s*/)
    .sort();
  assert.deepEqual(needs, [...others].sort());
  assert.match(all["ci-ok"] ?? "", /if: always\(\)/);
  assert.match(all["ci-ok"] ?? "", /r\.every\(\(x\) => x === "success"\)/);
});

test("audit.yml runs daily and on pushes to main, outside ci-ok, and keeps one issue", () => {
  const audit = workflows["audit.yml"] ?? "";
  assert.match(audit, /schedule:\n\s+- cron:/);
  assert.match(audit, /push:\n\s+branches: \[main\]/);
  assert.match(audit, /issues: write/);
  assert.doesNotMatch(jobsOf(workflows["ci.yml"] ?? "")["ci-ok"] ?? "", /audit\.yml/);
  assert.match(audit, /gh issue (create|edit|close)/);
});

/** The decide job's script, as the runner would run it. */
function decideScript(): string {
  const match = job("decide").match(
    /id: decide\n\s+env:\n(?: {10}.*\n)+\s+run: \|\n((?: {10}.*\n?)+)/,
  );
  assert.ok(match?.[1], "the decide step is not where the test looks for it");
  return match[1].replace(/^ {10}/gm, "");
}

type Case = {
  event: string;
  refType?: string;
  ref?: string;
  subject?: string;
  /** Whether a bundled dependency (react) moved since the latest tag. */
  bundled?: boolean;
  /** Whether the remote's main is a commit ahead of the checkout. */
  moved?: boolean;
};

const lock = (react: string) =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: { "": { name: "x" }, "node_modules/react": { version: react } },
  });

/** Runs the decide step in a throwaway clone whose tag v1.0.0 holds react 19.0.0. Returns its outputs. */
function decide(c: Case): string[] {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "follow-me-decide-")));
  try {
    const git = (cwd: string, ...args: string[]) => {
      const res = spawnSync("git", args, { cwd, encoding: "utf8" });
      assert.equal(res.status, 0, res.stderr);
      return res.stdout.trim();
    };
    const remote = join(dir, "remote.git");
    const work = join(dir, "work");
    mkdirSync(remote);
    git(remote, "init", "-q", "--bare", "-b", "main");
    mkdirSync(join(work, "scripts"), { recursive: true });
    copyFileSync(
      new URL("scripts/bundled-changed.ts", root),
      join(work, "scripts/bundled-changed.ts"),
    );
    writeFileSync(join(work, "package.json"), '{ "name": "x", "type": "module" }');
    git(work, "init", "-q", "-b", "main");
    git(work, "config", "user.email", "a@b.c");
    git(work, "config", "user.name", "a");
    git(work, "remote", "add", "origin", remote);
    writeFileSync(join(work, "package-lock.json"), lock("19.0.0"));
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "release 1.0.0");
    git(work, "tag", "v1.0.0");
    writeFileSync(join(work, "package-lock.json"), lock(c.bundled ? "19.0.1" : "19.0.0"));
    git(work, "commit", "-q", "--allow-empty", "-am", c.subject ?? "chore: update");
    if (c.moved) {
      git(work, "commit", "-q", "--allow-empty", "-m", "newer");
      git(work, "push", "-q", "origin", "HEAD:main");
      git(work, "reset", "-q", "--hard", "HEAD~1");
    } else {
      git(work, "push", "-q", "origin", "HEAD:main");
    }
    const out = join(dir, "out");
    const res = spawnSync("bash", ["-e", "-c", decideScript()], {
      cwd: work,
      env: {
        PATH: process.env["PATH"] ?? "",
        GITHUB_OUTPUT: out,
        EVENT: c.event,
        REF_TYPE: c.refType ?? "branch",
        REF: c.ref ?? "refs/heads/main",
      },
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr + res.stdout);
    return readFileSync(out, "utf8").trim().split("\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const mode = (c: Case) => decide(c)[0];

test("decide: a pushed tag publishes that tag, and only a push of one", () => {
  assert.equal(mode({ event: "push", refType: "tag", ref: "refs/tags/v1.0.1" }), "mode=tag");
  assert.equal(
    mode({ event: "workflow_dispatch", refType: "tag", ref: "refs/tags/v1.0.0" }),
    "mode=none",
  );
});

test("decide: a manual start from a branch other than main releases nothing, even with a bundled change", () => {
  assert.equal(
    mode({ event: "workflow_dispatch", ref: "refs/heads/feature", bundled: true }),
    "mode=none",
  );
  assert.equal(mode({ event: "workflow_dispatch", bundled: true }), "mode=release");
  assert.equal(mode({ event: "workflow_dispatch" }), "mode=none");
});

test("decide: a manual start does not release a commit that is no longer the head of main", () => {
  assert.equal(mode({ event: "workflow_dispatch", bundled: true, moved: true }), "mode=none");
});

test("decide: the weekly run releases only when a bundled dependency changed", () => {
  assert.equal(mode({ event: "schedule", bundled: true }), "mode=release");
  assert.equal(mode({ event: "schedule" }), "mode=none");
});

test("decide: a push releases only a security fix that changed a bundled dependency", () => {
  const security = "fix(deps): update dependency react to v19.0.1 [SECURITY]";
  assert.equal(mode({ event: "push", subject: security, bundled: true }), "mode=release");
  assert.equal(mode({ event: "push", subject: security }), "mode=none");
  assert.equal(mode({ event: "push", bundled: true }), "mode=none");
});

test("decide: a release commit is never released again, and the release records the commit it was decided on", () => {
  assert.equal(
    mode({ event: "schedule", bundled: true, subject: "chore(release): v1.0.1" }),
    "mode=none",
  );
  const [first, second] = decide({ event: "schedule", bundled: true });
  assert.equal(first, "mode=release");
  assert.match(second ?? "", /^base=[0-9a-f]{40}$/);
});
