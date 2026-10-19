import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PlanRequestError, requestPlan } from "./anthropic.ts";
import { DiffParseError, formatUnitRef } from "./diff.ts";
import { BranchRefusedError, GitError, treeOf, writeBranch } from "./git.ts";
import { serializePlanFile, type ValidPlan, validatePlan } from "./plan.ts";
import { type PromptInput, renderFeedback, renderPrompt } from "./prompt.ts";
import { loadDraftComments, serveReview } from "./server.ts";
import {
  BranchMovedError,
  cleanSessions,
  extractSession,
  openSession,
  type Session,
  SessionFileError,
  SessionLockedError,
} from "./session.ts";
import type {
  Diff,
  PlanIssue,
  PlanVersion,
  PlanWarning,
  RepoPath,
  Review,
  ReviewMode,
  Unit,
  UnitId,
} from "./types.ts";

class UsageError extends Error {
  override readonly name = "UsageError";
}

const USAGE = `usage: follow-me <command>

  extract [--base <ref>] [--branch <name>]  anchor a session and list the units
  check [path] [--branch <name>]            validate draft.json or the given plan file
  apply [--name <branch>] [--force]         write the draft as a branch of commits
  status                                    show the session's plans, reviews and branch
  prompt [--walk] [--branch <name>]         print the planner prompt for a coding agent
  plan [--walk] [--model <id>] [--branch <name>]
                                            ask the Anthropic API to write draft.json
  review [--port <n>] [--no-open]           review the latest plan commit by commit
  walk [--base <ref>] [--branch <name>] [--model <id>] [--port <n>] [--no-open]
                                            watch a branch being written, narrated, and
                                            review its code; nothing is applied
  feedback [--branch <name>]                print the latest review as markdown
  clean [--all] [--dry-run]                 remove sessions of deleted branches, finished
                                            review drafts and leftovers of dead processes;
                                            --all removes .follow-me/ entirely

--walk writes the prompt for a reviewer: a story with narration instead of a split.`;

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
      return `$.commits[${issue.commit}]: empty message`;
    case "empty-commit":
      return `$.commits[${issue.commit}]: no units`;
    case "unknown-unit":
      return `$.commits[${issue.commit}]: unknown unit ${issue.ref}`;
    case "bad-selection":
      return `$.commits[${issue.commit}]: ${issue.unit}: ${issue.reason}`;
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
      return `$.commits[${issue.commit}]: ${show(issue.file)} is a file while ${show(issue.under)} exists`;
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

/** " --branch x" when the user named a branch, so printed commands reach the same session. */
function branchFlag(args: Args): string {
  const branch = args.values.get("branch");
  return branch === undefined ? "" : ` --branch ${branch}`;
}

function portOf(args: Args): { port?: number } {
  const raw = args.values.get("port");
  if (raw === undefined) return {};
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UsageError(`--port ${raw} is not a port number`);
  }
  return { port };
}

function modeOf(args: Args): ReviewMode {
  return args.flags.has("walk") ? "walk" : "split";
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
  const session = await openSession(cwd, sessionOpts(args));
  const path = args.positionals[0];
  const verdict = validate(session, path === undefined ? session.readDraft() : readPlanArg(path));
  if (!verdict.ok) return 1;
  const { plan } = verdict;
  say(`ok: ${plural(plan.commits.length, "commit")}, plan ${short(plan.hash)}`);
  for (const c of plan.commits) {
    const subject = c.message.split("\n")[0] ?? "";
    say(
      `  ${c.index + 1}  ${subject}  (${plural(c.refs.length, "unit")}, ${plural(c.changes.length, "file")})`,
    );
  }
  for (const w of verdict.warnings) say(formatWarning(w));
  return 0;
}

/** Runs one command under the session's lock, so two agents never apply or review it at once. */
async function locked(
  session: Session,
  command: string,
  run: () => Promise<number>,
): Promise<number> {
  const release = session.lock(command);
  try {
    return await run();
  } finally {
    release();
  }
}

async function apply(cwd: string, args: Args): Promise<number> {
  const session = await openSession(cwd);
  return locked(session, "apply", () => applyLocked(session, args));
}

async function applyLocked(session: Session, args: Args): Promise<number> {
  const verdict = validate(session, session.readDraft());
  if (!verdict.ok) return 1;
  const version = session.freeze(verdict.plan);
  const name = args.values.get("name") ?? `${session.anchor.branch}-split`;
  const last = session.applied();
  const result = await writeBranch(session.root, session.diff, verdict.plan, {
    name,
    source: session.anchor.branch,
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

function promptInput(session: Session, mode: ReviewMode, args: Args): PromptInput {
  const common = {
    diff: session.diff,
    draftPath: session.draftPath,
    checkCommand: `follow-me check${branchFlag(args)}`,
  };
  if (mode === "walk") return { ...common, mode };
  return {
    ...common,
    mode,
    previousPlan: session.plans().at(-1)?.file ?? null,
    review: session.lastReview(),
  };
}

/** Asks the API for draft.json, feeding issues back once. Returns the plan when it validates. */
async function draftWithApi(
  session: Session,
  cwd: string,
  mode: ReviewMode,
  args: Args,
): Promise<ValidPlan | null> {
  const model = args.values.get("model");
  const opts = model === undefined ? {} : { model };
  let prompt = renderPrompt(promptInput(session, mode, args));
  for (let round = 1; round <= 2; round++) {
    const draft = await requestPlan(prompt, opts);
    session.writeDraft(draft);
    const verdict = validate(session, draft);
    if (verdict.ok) {
      say(
        `wrote ${relative(cwd, session.draftPath)} (${plural(verdict.plan.commits.length, "commit")})`,
      );
      return verdict.plan;
    }
    const issues = verdict.issues.map((issue) => `- ${formatIssue(issue)}`).join("\n");
    prompt = `${prompt}\n\n## Your previous draft had these issues, write a corrected plan\n\n${issues}\n`;
  }
  say(
    `wrote ${relative(cwd, session.draftPath)} but it still has issues, repair it and run \`follow-me check${branchFlag(args)}\``,
  );
  return null;
}

async function plan(cwd: string, args: Args): Promise<number> {
  const session = await openSession(cwd, sessionOpts(args));
  return (await draftWithApi(session, cwd, modeOf(args), args)) === null ? 1 : 0;
}

/** The latest frozen plan, or the draft frozen now when it validates. */
function latestPlan(session: Session): { version: PlanVersion; plan: ValidPlan } | null {
  const stored = session.plans().at(-1);
  if (stored !== undefined) {
    const verdict = validate(session, serializePlanFile(stored.file));
    return verdict.ok ? { version: stored.version, plan: verdict.plan } : null;
  }
  const verdict = validate(session, session.readDraft());
  if (!verdict.ok) return null;
  return { version: session.freeze(verdict.plan), plan: verdict.plan };
}

async function serve(
  session: Session,
  mode: ReviewMode,
  latest: { version: PlanVersion; plan: ValidPlan },
  args: Args,
): Promise<Review> {
  const { version, plan } = latest;
  const reviewsDir = join(session.dir, "reviews");
  return serveReview(
    {
      mode,
      anchor: session.anchor,
      version,
      planHash: plan.hash,
      commits: plan.commits,
      units: [...session.diff.units.values()],
      comments: await loadDraftComments(reviewsDir, version),
    },
    { reviewsDir, open: !args.flags.has("no-open"), ...portOf(args) },
  );
}

function alreadyReviewed(session: Session, version: PlanVersion, args: Args): boolean {
  if (!session.reviews().some((r) => r.version === version)) return false;
  console.error(
    `follow-me: plan v${version} already has a review; read it with \`follow-me feedback${branchFlag(args)}\` or plan again first`,
  );
  return true;
}

async function review(cwd: string, args: Args): Promise<number> {
  const session = await openSession(cwd);
  return locked(session, "review", () => reviewLocked(session, args));
}

async function reviewLocked(session: Session, args: Args): Promise<number> {
  const latest = latestPlan(session);
  if (latest === null) return 1;
  if (alreadyReviewed(session, latest.version, args)) return 1;
  const review = await serve(session, "split", latest, args);
  say(`review v${latest.version} saved with ${plural(review.comments.length, "comment")}`);
  return 0;
}

/** Opens the reviewer's session, re-extracting instead of failing when the branch moved. */
async function openForWalk(cwd: string, args: Args): Promise<Session> {
  const opts = sessionOpts(args);
  try {
    const session = await openSession(cwd, opts);
    const rebased = opts.base !== undefined && opts.base !== session.anchor.baseRef;
    return rebased ? await extractSession(cwd, opts) : session;
  } catch (error) {
    if (!(error instanceof BranchMovedError)) throw error;
    const session = await extractSession(cwd, opts);
    say(`${session.anchor.branch} moved, re-extracted at ${short(session.anchor.tip)}`);
    return session;
  }
}

/** The latest frozen plan if it still fits the diff, else a valid draft frozen now. Silent. */
function walkablePlan(session: Session): { version: PlanVersion; plan: ValidPlan } | null {
  const lastReview = session.lastReview();
  const stored = session.plans().at(-1);
  if (stored !== undefined) {
    const verdict = validatePlan(session.diff, serializePlanFile(stored.file), { lastReview });
    if (verdict.ok) return { version: stored.version, plan: verdict.plan };
  }
  let draft: unknown;
  try {
    draft = session.readDraft();
  } catch (error) {
    if (error instanceof SessionFileError) return null;
    throw error;
  }
  const verdict = validatePlan(session.diff, draft, { lastReview });
  return verdict.ok ? { version: session.freeze(verdict.plan), plan: verdict.plan } : null;
}

function hasApiCredentials(): boolean {
  return Boolean(process.env["ANTHROPIC_API_KEY"] || process.env["ANTHROPIC_AUTH_TOKEN"]);
}

async function walk(cwd: string, args: Args): Promise<number> {
  const session = await openForWalk(cwd, args);
  return locked(session, "walk", () => walkLocked(session, cwd, args));
}

async function walkLocked(session: Session, cwd: string, args: Args): Promise<number> {
  let latest = walkablePlan(session);
  if (latest === null) {
    if (!hasApiCredentials()) {
      say(
        `no plan for ${session.anchor.branch} yet, and neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set to ask the API for one.`,
      );
      say("Have a coding agent follow the prompt, then walk again:");
      say(`  follow-me prompt --walk${branchFlag(args)}`);
      say(`  follow-me walk${branchFlag(args)}`);
      return 1;
    }
    const drafted = await draftWithApi(session, cwd, "walk", args);
    if (drafted === null) return 1;
    latest = { version: session.freeze(drafted), plan: drafted };
  }
  if (alreadyReviewed(session, latest.version, args)) return 1;
  const review = await serve(session, "walk", latest, args);
  const saved = join(session.dir, "reviews", `v${latest.version}.json`);
  say(
    `code review saved to ${relative(cwd, saved)} with ${plural(review.comments.length, "comment")}`,
  );
  say(`\`follow-me feedback${branchFlag(args)}\` prints it as a code review for the author`);
  return 0;
}

async function feedback(cwd: string, args: Args): Promise<number> {
  const session = await openSession(cwd, sessionOpts(args));
  const stored = session.reviews().at(-1);
  if (stored === undefined) {
    console.error("follow-me: no review yet, run `follow-me review` first");
    return 1;
  }
  const plan = session.plans().find((p) => p.version === stored.version);
  if (plan === undefined) {
    console.error(`follow-me: review v${stored.version} refers to a plan that is missing`);
    return 1;
  }
  process.stdout.write(renderFeedback(stored.review, plan.file, session.diff.units));
  return 0;
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
        return await check(cwd, parseArgs(rest, { values: ["branch"] }));
      case "apply":
        return await apply(cwd, parseArgs(rest, { values: ["name"], flags: ["force"] }));
      case "status":
        parseArgs(rest, {});
        return await status(cwd);
      case "prompt": {
        const args = parseArgs(rest, { values: ["branch"], flags: ["walk"] });
        const session = await openSession(cwd, sessionOpts(args));
        process.stdout.write(renderPrompt(promptInput(session, modeOf(args), args)));
        return 0;
      }
      case "plan":
        return await plan(cwd, parseArgs(rest, { values: ["model", "branch"], flags: ["walk"] }));
      case "review":
        return await review(cwd, parseArgs(rest, { values: ["port"], flags: ["no-open"] }));
      case "walk": {
        const spec = { values: ["base", "branch", "model", "port"], flags: ["no-open"] };
        return await walk(cwd, parseArgs(rest, spec));
      }
      case "feedback":
        return await feedback(cwd, parseArgs(rest, { values: ["branch"] }));
      case "clean": {
        const args = parseArgs(rest, { flags: ["all", "dry-run"] });
        const opts = { all: args.flags.has("all"), dryRun: args.flags.has("dry-run") };
        for (const path of await cleanSessions(cwd, opts)) say(relative(cwd, path));
        return 0;
      }
      case undefined:
      case "help":
      case "--help":
        say(USAGE);
        return command === undefined ? 1 : 0;
      default:
        throw new UsageError(`unknown command "${command}"\n${USAGE}`);
    }
  } catch (error) {
    const known = [
      UsageError,
      BranchMovedError,
      BranchRefusedError,
      SessionFileError,
      SessionLockedError,
      GitError,
      PlanRequestError,
    ];
    if (error instanceof DiffParseError) {
      console.error(`follow-me: could not parse the diff, please report this: ${error.message}`);
    } else if (error instanceof Error && known.some((k) => error instanceof k)) {
      console.error(`follow-me: ${error.message}`);
    } else console.error(error);
    return 1;
  }
}
