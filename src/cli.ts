import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { DiffParseError, formatUnitRef } from "./diff.ts";
import { BranchRefusedError, GitError, treeOf, writeBranch } from "./git.ts";
import { validatePlan } from "./plan.ts";
import {
  BranchMovedError,
  extractSession,
  openSession,
  type Session,
  SessionFileError,
} from "./session.ts";
import type { Diff, PlanIssue, PlanWarning, RepoPath, Unit, UnitId } from "./types.ts";

class UsageError extends Error {
  override readonly name = "UsageError";
}

const USAGE = `usage: follow-me <command>

  extract [--base <ref>] [--branch <name>]  anchor a session and list the units
  check [path]                              validate draft.json or the given plan file
  apply [--name <branch>] [--force]         write the draft as a branch of commits
  status                                    show the session's plans, reviews and branch
  prompt | plan | review | feedback         not wired yet`;

type Args = {
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
};

function parseArgs(
  argv: readonly string[],
  spec: { readonly values?: readonly string[]; readonly flags?: readonly string[] },
): Args {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (spec.values?.includes(name)) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || value === "") throw new UsageError(`--${name} needs a value`);
      values.set(name, value);
    } else if (spec.flags?.includes(name) && eq === -1) flags.add(name);
    else throw new UsageError(`unknown option ${arg}`);
  }
  return { positionals, values, flags };
}

function say(line = ""): void {
  process.stdout.write(`${line}\n`);
}

/** Paths are latin1 so bytes round-trip; show them as the UTF-8 the user typed. */
function show(path: RepoPath): string {
  return Buffer.from(path, "latin1").toString("utf8");
}

function short(sha: string): string {
  return sha.slice(0, 12);
}

function lines(unit: UnitId, changes: readonly number[]): string {
  return formatUnitRef({ unit, select: { kind: "lines", changes } });
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function describeFile(diff: Diff, units: readonly Unit[]): { status: string; what: string } {
  const parts: string[] = [];
  let status = "M";
  const hunks = units.flatMap((u) => (u.kind === "hunk" ? [u] : []));
  if (hunks.length > 0) {
    const changes = hunks.reduce((n, h) => n + h.changeCount, 0);
    parts.push(`${plural(hunks.length, "hunk")}, ${plural(changes, "change line")}`);
  }
  for (const u of units) {
    if (u.kind === "mode") parts.push(`mode ${u.from} -> ${u.to}`);
    if (u.kind === "file") {
      parts.push(u.reason);
      status =
        u.reason === "typechange" ? "T" : u.before === null ? "A" : u.after === null ? "D" : "M";
    }
  }
  const text = units[0] && diff.textFiles.get(units[0].path);
  if (text) status = text.base === null ? "A" : text.tip === null ? "D" : "M";
  return { status, what: parts.join(", ") };
}

function summarize(session: Session, cwd: string): void {
  const { anchor, diff } = session;
  const byPath = new Map<RepoPath, Unit[]>();
  for (const unit of diff.units.values()) {
    byPath.set(unit.path, [...(byPath.get(unit.path) ?? []), unit]);
  }
  say(
    `${anchor.branch} ${short(anchor.tip)} onto ${anchor.baseRef} ${short(anchor.base)}: ${plural(byPath.size, "file")}, ${plural(diff.units.size, "unit")}`,
  );
  const width = Math.max(0, ...[...byPath.keys()].map((p) => show(p).length));
  for (const [path, units] of byPath) {
    const { status, what } = describeFile(diff, units);
    say(`  ${status} ${show(path).padEnd(width)}  ${what}`);
  }
  say(`session ${relative(cwd, session.dir) || "."}`);
}

function formatIssue(issue: PlanIssue): string {
  switch (issue.kind) {
    case "malformed":
      return `malformed ${issue.at}: ${issue.reason}`;
    case "stale":
      return `stale: the plan is for tip ${short(issue.planTip)} but the session tip is ${short(issue.sessionTip)}`;
    case "empty-message":
      return `commit ${issue.commit}: empty message`;
    case "empty-commit":
      return `commit ${issue.commit}: no units`;
    case "unknown-unit":
      return `commit ${issue.commit}: unknown unit ${issue.ref}`;
    case "bad-selection":
      return `commit ${issue.commit}: ${issue.unit}: ${issue.reason}`;
    case "duplicate": {
      const [a, b] = issue.commits;
      const what = issue.changes.length > 0 ? lines(issue.unit, issue.changes) : issue.unit;
      return `${what} is claimed by commits ${a} and ${b}`;
    }
    case "unassigned": {
      const what = issue.changes.length > 0 ? lines(issue.unit, issue.changes) : issue.unit;
      return `${what} (${show(issue.path)}) is in no commit`;
    }
    case "path-conflict":
      return `commit ${issue.commit}: ${show(issue.file)} is a file while ${show(issue.under)} exists`;
    case "unknown-response":
      return `response to unknown comment ${issue.comment}`;
    case "final-mismatch": {
      const tip = issue.expected ? `${issue.expected.mode} ${issue.expected.blob}` : "absent";
      return `${show(issue.path)}: the last commit has ${issue.got}, the tip has ${tip}`;
    }
    default: {
      const exhaustive: never = issue;
      return exhaustive;
    }
  }
}

function formatWarning(w: PlanWarning): string {
  return `warning: comment ${w.comment} from review v${w.review} has no response`;
}

function readPlanArg(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new UsageError(`cannot read ${path}: ${error instanceof Error ? error.message : error}`);
  }
}

function sessionOpts(args: Args): { branch?: string; base?: string } {
  const branch = args.values.get("branch");
  const base = args.values.get("base");
  return { ...(branch === undefined ? {} : { branch }), ...(base === undefined ? {} : { base }) };
}

function validate(session: Session, draft: unknown) {
  const verdict = validatePlan(session.diff, draft, { lastReview: session.lastReview() });
  if (!verdict.ok) for (const issue of verdict.issues) say(formatIssue(issue));
  return verdict;
}

async function check(cwd: string, args: Args): Promise<number> {
  const session = await openSession(cwd);
  const path = args.positionals[0];
  const verdict = validate(session, path === undefined ? session.readDraft() : readPlanArg(path));
  if (!verdict.ok) return 1;
  const { plan } = verdict;
  say(`ok: ${plural(plan.commits.length, "commit")}, plan ${short(plan.hash)}`);
  for (const c of plan.commits) {
    const subject = c.message.split("\n")[0] ?? "";
    say(
      `  ${c.index}  ${subject}  (${plural(c.refs.length, "unit")}, ${plural(c.changes.length, "file")})`,
    );
  }
  for (const w of verdict.warnings) say(formatWarning(w));
  return 0;
}

async function apply(cwd: string, args: Args): Promise<number> {
  const session = await openSession(cwd);
  const verdict = validate(session, session.readDraft());
  if (!verdict.ok) return 1;
  const version = session.freeze(verdict.plan);
  const name = args.values.get("name") ?? `${session.anchor.branch}-split`;
  const last = session.applied();
  const result = await writeBranch(session.root, session.diff, verdict.plan, {
    name,
    expectedOld: last?.branch === name ? last.head : null,
    force: args.flags.has("force"),
  });
  session.recordApplied(version, result);
  for (const w of verdict.warnings) say(formatWarning(w));
  say(
    `${result.kind} ${result.branch} at ${short(result.head)} from plan v${version} (${plural(result.commits.length, "commit")})`,
  );
  const tree = await treeOf(session.root, result.head);
  const same = tree === session.anchor.tipTree;
  say(
    `proof: ${result.branch}^{tree} ${tree} ${same ? "equals" : "DIFFERS FROM"} ${session.anchor.branch}^{tree} ${session.anchor.tipTree}`,
  );
  return same ? 0 : 1;
}

async function status(cwd: string): Promise<number> {
  const session = await openSession(cwd);
  const { anchor, diff } = session;
  const plans = session.plans();
  const reviews = session.reviews();
  say(`${anchor.branch} ${short(anchor.tip)} onto ${anchor.baseRef} ${short(anchor.base)}`);
  say(`units: ${plural(diff.units.size, "unit")}`);
  let hasDraft = true;
  try {
    session.readDraft();
  } catch (error) {
    if (!(error instanceof SessionFileError)) throw error;
    hasDraft = false;
  }
  say(`draft: ${hasDraft ? relative(cwd, session.draftPath) : "none"}`);
  say(`plans: ${plans.map((p) => `v${p.version}`).join(", ") || "none"}`);
  const lastReview = reviews.at(-1);
  if (lastReview === undefined) say("reviews: none");
  else {
    const answered = new Set(
      plans
        .filter((p) => p.version > lastReview.version)
        .flatMap((p) => p.file.responses.map((r) => r.comment)),
    );
    const open = lastReview.review.comments.filter((c) => !answered.has(c.id)).length;
    say(
      `reviews: ${reviews.map((r) => `v${r.version}`).join(", ")} (latest has ${plural(lastReview.review.comments.length, "comment")}, ${open} open)`,
    );
  }
  const applied = session.applied();
  say(
    applied === null
      ? "applied: never"
      : `applied: plan v${applied.version} as ${applied.branch} at ${short(applied.head)}`,
  );
  return 0;
}

export async function main(argv: readonly string[], cwd: string): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "extract": {
        const args = parseArgs(rest, { values: ["base", "branch"] });
        summarize(await extractSession(cwd, sessionOpts(args)), cwd);
        return 0;
      }
      case "check":
        return await check(cwd, parseArgs(rest, {}));
      case "apply":
        return await apply(cwd, parseArgs(rest, { values: ["name"], flags: ["force"] }));
      case "status":
        parseArgs(rest, {});
        return await status(cwd);
      case "prompt":
      case "plan":
      case "review":
      case "feedback":
        console.error(`follow-me ${command}: not wired yet`);
        return 1;
      case undefined:
      case "help":
      case "--help":
        say(USAGE);
        return command === undefined ? 1 : 0;
      default:
        throw new UsageError(`unknown command "${command}"\n${USAGE}`);
    }
  } catch (error) {
    const known = [UsageError, BranchMovedError, BranchRefusedError, SessionFileError, GitError];
    if (error instanceof DiffParseError) {
      console.error(`follow-me: could not parse the diff, please report this: ${error.message}`);
    } else if (error instanceof Error && known.some((k) => error instanceof k)) {
      console.error(`follow-me: ${error.message}`);
    } else console.error(error);
    return 1;
  }
}
