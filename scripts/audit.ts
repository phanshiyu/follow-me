#!/usr/bin/env node
/**
 * Compares two `npm audit --json` reports, so a pull request fails only on an advisory its base
 * branch does not have (docs/decisions.tsv, "advisories do not block their fix").
 *
 * usage: node scripts/audit.ts <head audit.json> [<base audit.json>] [--plain]
 *   Prints the advisories of moderate severity or worse that the head has and the base does not;
 *   without a base, all of them. --plain leaves out the GitHub annotations, for an issue body.
 *   Exits 0 when there are none, 1 when there are, 2 when an audit did not run, so a registry
 *   error never reads as a clean tree.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Advisory = { id: string; name: string; severity: string; title: string };

const RANK: Record<string, number> = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);

/** The advisories at or above `minimum`, keyed by advisory id and package name. */
export function readAudit(json: string, minimum = "moderate"): Map<string, Advisory> {
  let report: unknown;
  try {
    report = JSON.parse(json);
  } catch {
    throw new Error("The audit printed no JSON, so it did not run (a registry or network error?)");
  }
  if (!isRecord(report)) throw new Error("The audit output is not a JSON object");
  const failure = report["error"];
  if (failure !== undefined) {
    const detail = isRecord(failure) ? (failure["summary"] ?? failure["message"]) : failure;
    throw new Error(`The audit failed: ${text(detail, JSON.stringify(failure))}`);
  }
  const vulnerabilities = report["vulnerabilities"];
  if (!isRecord(vulnerabilities)) {
    if (isRecord(report["metadata"])) return new Map();
    throw new Error("The audit output has no vulnerabilities field");
  }
  const found = new Map<string, Advisory>();
  for (const vulnerability of Object.values(vulnerabilities)) {
    const via = isRecord(vulnerability) ? vulnerability["via"] : undefined;
    for (const source of Array.isArray(via) ? via : []) {
      // A string in `via` names another package that carries the advisory; that package has its own entry.
      if (!isRecord(source)) continue;
      const severity = text(source["severity"], "info");
      if ((RANK[severity] ?? 0) < (RANK[minimum] ?? 2)) continue;
      const url = text(source["url"], "");
      const id = url ? (url.split("/").pop() ?? url) : String(source["source"] ?? "unknown");
      const name = text(source["name"], "unknown");
      found.set(`${id} ${name}`, { id, name, severity, title: text(source["title"], "") });
    }
  }
  return found;
}

/** The advisories in `head` that `base` does not have. With no base, all of them. */
export function newAdvisories(
  head: Map<string, Advisory>,
  base: Map<string, Advisory> = new Map(),
): Advisory[] {
  return [...head].filter(([key]) => !base.has(key)).map(([, advisory]) => advisory);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const plain = process.argv.includes("--plain");
  const [headFile, baseFile] = process.argv.slice(2).filter((arg) => arg !== "--plain");
  if (!headFile) {
    console.error("usage: node scripts/audit.ts <head audit.json> [<base audit.json>] [--plain]");
    process.exit(2);
  }
  const out = (line: string) => process.stdout.write(`${line}\n`);
  try {
    const head = readAudit(readFileSync(headFile, "utf8"));
    const base = baseFile ? readAudit(readFileSync(baseFile, "utf8")) : undefined;
    const found = newAdvisories(head, base);
    const scope = base ? "not on the base branch" : "moderate or worse";
    if (found.length === 0) {
      out(`No advisories ${scope}. ${head.size} moderate or worse in the tree.`);
    } else {
      out(`${found.length} advisories ${scope}:`);
      for (const { id, name, severity, title } of found)
        out(`- ${severity}: ${name}, ${title} (${id})`);
      if (!plain) {
        for (const { id, name, severity, title } of found) {
          out(`::error title=${severity} advisory in ${name}::${title} (${id})`);
        }
      }
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(
      `::error title=The audit did not run::${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 2;
  }
}
