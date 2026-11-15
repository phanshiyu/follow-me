import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newAdvisories, readAudit } from "../scripts/audit.ts";

const via = (name: string, severity: string, id: string) => ({
  source: 1,
  name,
  severity,
  title: `${name} problem`,
  url: `https://github.com/advisories/${id}`,
});
const report = (vulnerabilities: Record<string, unknown>) =>
  JSON.stringify({ vulnerabilities, metadata: {} });

test("moderate and worse count, low and string references do not", () => {
  const found = readAudit(
    report({
      a: { via: [via("a", "moderate", "GHSA-1")] },
      b: { via: [via("b", "low", "GHSA-2")] },
      c: { via: ["a"] },
      d: { via: [via("d", "critical", "GHSA-3")] },
    }),
  );
  assert.deepEqual([...found.keys()].sort(), ["GHSA-1 a", "GHSA-3 d"]);
});

test("only an advisory the base lacks is new", () => {
  const base = readAudit(report({ a: { via: [via("a", "high", "GHSA-1")] } }));
  const head = readAudit(
    report({
      a: { via: [via("a", "high", "GHSA-1")] },
      b: { via: [via("b", "high", "GHSA-9")] },
    }),
  );
  assert.deepEqual(
    newAdvisories(head, base).map((a) => a.id),
    ["GHSA-9"],
  );
  assert.deepEqual(newAdvisories(base, head), []);
  assert.equal(newAdvisories(head).length, 2);
});

test("a clean tree is empty, and an audit that did not run is an error", () => {
  assert.equal(readAudit(JSON.stringify({ vulnerabilities: {}, metadata: {} })).size, 0);
  assert.throws(() => readAudit("not json"), /did not run/);
  assert.throws(() => readAudit(JSON.stringify({ error: { summary: "ENOTFOUND" } })), /ENOTFOUND/);
  assert.throws(() => readAudit(JSON.stringify({ hello: 1 })), /no vulnerabilities/);
});

test("the command exits 1 on a new advisory, 0 on none, 2 when an audit did not run", () => {
  const dir = mkdtempSync(join(tmpdir(), "follow-me-audit-"));
  try {
    const write = (name: string, body: string) => {
      writeFileSync(join(dir, name), body);
      return join(dir, name);
    };
    const bad = write("bad.json", report({ a: { via: [via("a", "high", "GHSA-1")] } }));
    const clean = write("clean.json", report({}));
    const broken = write("broken.json", "oops");
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ["scripts/audit.ts", ...args], { encoding: "utf8" });
    assert.equal(run(bad, clean).status, 1);
    assert.match(run(bad, clean).stdout, /::error title=high advisory in a/);
    assert.doesNotMatch(run(bad, clean, "--plain").stdout, /::error/);
    assert.equal(run(bad, bad).status, 0);
    assert.equal(run(clean).status, 0);
    assert.equal(run(broken, clean).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
