import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PlanRequestError, requestPlan } from "./anthropic.ts";
import { DiffParseError, formatUnitRef } from "./diff.ts";
import {
  BranchRefusedError,
  branchHead,
  GitError,
  type Signing,
  type SignMode,
  signing,
  treeOf,
  type WriteResult,
  writeBranch,
} from "./git.ts";
import {
  fetchReport,
  findServer,
  followEvents,
  idleMs,
  listSessions,
  openBrowser,
  pollEvents,
  portFallbackMessage,
  postReply,
  probeHealth,
  registerWith,
  type Started,
  sessionUrl,
  spawnDetached,
  startOrAttach,
  stateDir,
  stillHosted,
  stopServer,
  swapVersion,
} from "./host.ts";
import { runInstall, runUninstall, type SkillTargets } from "./install.ts";
import { naiveDraft } from "./naive.ts";
import { serializePlanFile, type ValidPlan, validatePlan } from "./plan.ts";
import { type PromptInput, renderEvents, renderPrompt, renderReport } from "./prompt.ts";
import { type Registration, RegistrationError, sessionIdOf } from "./server.ts";
import {
  BranchMovedError,
  cleanSessions,
  extractSession,
  type HeldLock,
  type LockState,
  MissingDraftError,
  NotARepositoryError,
  openSession,
  type Session,
  SessionFileError,
  SessionLockedError,
  type StoredReview,
} from "./session.ts";
import { checkSyntax, type SyntaxReport } from "./syntax.ts";
import type {
  Diff,
  HostedSummary,
  PlanIssue,
  PlanVersion,
  PlanWarning,
  RepoPath,
  Review,
  ReviewMode,
  ServerEvent,
  Unit,
  UnitId,
} from "./types.ts";

class UsageError extends Error {
  override readonly name = "UsageError";
}

const USAGE = `usage: follow-me <command> [options]

Split your own branch:
  split [--base <ref>] [--branch <name>] [--model <id>] [--no-open]
                                            extract, draft (with an Anthropic key), apply and
                                            open the review in one go
  extract [--base <ref>] [--branch <name>]  anchor a session and list the units
  prompt [--walk] [--branch <name>]         print the planner prompt; your coding agent
                                            writes draft.json from it
  plan [--walk] [--model <id>] [--branch <name>]
                                            the same draft as prompt, written by the
                                            Anthropic API
  plan --naive [--branch <name>]            no API, no agent: one "wip: <path>" commit per
                                            touched file, in diff order
  check [path] [--branch <name>] [--syntax "<cmd {file}>"]
                                            validate draft.json or the given plan file, and
                                            check that every file each commit writes parses;
                                            --syntax runs <cmd> on every text file instead of
                                            the checker for its extension
  apply [--name <branch>] [--force] [--sign|--no-sign] [--syntax "<cmd {file}>"]
        [--allow-syntax-errors]             write the draft as commits on <branch>-split or
                                            --name; never on <branch> or a checked-out branch;
                                            refuses a commit with a file that does not parse
                                            unless --allow-syntax-errors
  review [--port <n>] [--detach] [--no-open] [--wait [--timeout <seconds>]]
                                            open the plan review, commit by commit; --wait
                                            returns only once the review ends
  feedback [--walk] [--branch <name>]       print the latest plan review as markdown, or with
                                            --walk the latest code review
  status                                    show the session's plans, reviews, lock and the
                                            branch apply writes

Interactive loop (while the review page is open):
  watch [--since <seq>] [--timeout <seconds>] [--json] [--follow]
                                            wait for the reviewer to comment, ask or decide and
                                            print it; exits 0 with news, 2 on timeout, and
                                            reports the end of the review. Your own replies are
                                            left out. --follow streams every event until the
                                            review ends instead of stopping at the first
  reply <commentId> --body <text> [--diagram <file>]
                                            answer under a comment on the page; the diagram is
                                            Mermaid source
  report                                    print the consolidated report of the open review, or
                                            of the last one that ended: issues by file and line
                                            in both voices, then questions with answers
  apply, while the page is open, swaps it to the new plan version in place, same URL.

Review someone else's branch:
  walk [--base <ref>] [--branch <name>] [--model <id>] [--port <n>] [--detach] [--no-open]
                                            watch a branch being written, narrated, and
                                            review its code; nothing is applied

Review server:
  server status                             show the review server and the sessions it hosts
  server stop                               stop the review server; drafts are kept

Setup:
  install [--harness <ids>|--all] [--project] [--dry-run]
                                            copy the skill into coding agents' skill dirs
  install --list                            show each harness, its skill dirs and docs
  uninstall [--harness <ids>|--all] [--project] [--dry-run]
                                            remove the skill files install writes
  clean [--all] [--dry-run]                 remove sessions of deleted branches, finished
                                            review drafts and leftovers of dead processes;
                                            --all removes .follow-me/ entirely
  --version                                 print the version
  help                                      print this

--walk writes the prompt for a reviewer: a story with narration instead of a split.
review and walk share one server per user: a running one hosts the session and the command
prints its URL; otherwise the command serves until its review ends, or with --detach starts the
server in the background. --port taken by another program falls back to a free port.
--force lets apply move a branch follow-me did not create; it never allows <branch> itself.
apply signs the commits when your git config signs commits (commit.gpgsign, gpg.format);
--sign signs them anyway and --no-sign never signs.`;

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

/** The step that follows; every command that moves the flow forward ends with one. */
function next(step: string): void {
  say(`next: ${step}`);
}

/**
 * The version in the package.json above this module, which sits one directory up from src/ and
 * two up from dist/src/.
 */
function version(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 3; depth++) {
    dir = dirname(dir);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    if (typeof raw !== "object" || raw === null) continue;
    const name = "name" in raw ? raw.name : undefined;
    const value = "version" in raw ? raw.version : undefined;
    if (name === "@shiyuphan/follow-me" && typeof value === "string") return value;
  }
  throw new Error("cannot find the package.json of follow-me");
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

function unitsByPath(diff: Diff): Map<RepoPath, Unit[]> {
  const byPath = new Map<RepoPath, Unit[]>();
  for (const unit of diff.units.values()) {
    byPath.set(unit.path, [...(byPath.get(unit.path) ?? []), unit]);
  }
  return byPath;
}

function headline(session: Session): string {
  const { anchor, diff } = session;
  const files = unitsByPath(diff).size;
  return `${anchor.branch} ${short(anchor.tip)} onto ${anchor.baseRef} ${short(anchor.base)}: ${plural(files, "file")}, ${plural(diff.units.size, "unit")}`;
}

function summarize(session: Session, cwd: string): void {
  const { diff } = session;
  const byPath = unitsByPath(diff);
  say(headline(session));
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
    case "bad-answer":
      return `response to ${issue.comment}: ${issue.reason}`;
    case "bad-concern":
      return `$.commits[${issue.commit}]: concern: ${issue.reason}`;
    case "too-many-concerns":
      return `${issue.unit} has more than one concern, in commits ${issue.commits.join(" and ")}; keep the one that matters`;
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
  if (w.kind === "long-title") {
    return `warning: $.commits[${w.commit}]: title is ${w.length} characters; keep it to 50`;
  }
  if (w.kind === "question-addressed") {
    return `warning: question ${w.comment} is marked addressed; explain it with "answered" and "at" unless answering it changed the plan`;
  }
  return `warning: comment ${w.comment} from review v${w.review} has no response`;
}

function concernTally(commits: readonly { readonly concerns?: readonly { severity: string }[] }[]) {
  const all = commits.flatMap((c) => c.concerns ?? []);
  const parts = ["blocker", "major", "minor"].flatMap((severity) => {
    const n = all.filter((c) => c.severity === severity).length;
    return n === 0 ? [] : [`${n} ${severity}`];
  });
  return parts.length === 0 ? null : `concerns: ${parts.join(", ")}`;
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

function portOf(args: Args): number | undefined {
  const raw = args.values.get("port");
  if (raw === undefined) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UsageError(`--port ${raw} is not a port number`);
  }
  return port === 0 ? undefined : port;
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
  if (!verdict.ok) {
    const fix = path ?? relative(cwd, session.draftPath);
    next(
      `fix ${fix}, then follow-me check${path === undefined ? "" : ` ${path}`}${branchFlag(args)}`,
    );
    return 1;
  }
  listPlan(verdict.plan);
  for (const w of verdict.warnings) say(formatWarning(w));
  const syntax = await checkSyntax(verdict.plan, syntaxOverride(args));
  for (const line of formatSyntax(syntax)) say(line);
  if (syntax.issues.length > 0) {
    next(`fix the commits above so every file parses, then follow-me check${branchFlag(args)}`);
    return 1;
  }
  next("follow-me apply");
  return 0;
}

function syntaxOverride(args: Args): { override?: string } {
  const override = args.values.get("syntax");
  if (override === undefined) return {};
  if (!override.includes("{file}")) throw new UsageError("--syntax needs {file} in the command");
  return { override };
}

function formatSyntax(report: SyntaxReport, mark = ""): string[] {
  const out = report.issues.map(
    (i) => `${mark}$.commits[${i.commit}]: ${show(i.path)}: ${i.message}`,
  );
  for (const i of report.tip) {
    out.push(
      `${mark}${show(i.path)}: ${i.message} (the tip itself does not parse here, so earlier commits are not checked for it)`,
    );
  }
  const reasons = [...new Set(report.skipped.map((s) => s.reason))];
  const skipped =
    reasons.length === 0
      ? ""
      : `, ${plural(report.skipped.length, "file")} skipped (${reasons.join(", ")})`;
  out.push(`syntax: ${plural(report.checked, "write")} checked${skipped}`);
  return out;
}

function listPlan(plan: ValidPlan): void {
  say(`ok: ${plural(plan.commits.length, "commit")}, plan ${short(plan.hash)}`);
  for (const c of plan.commits) {
    const subject = c.message.split("\n")[0] ?? "";
    say(
      `  ${c.index + 1}  ${subject}  (${plural(c.refs.length, "unit")}, ${plural(c.changes.length, "file")})`,
    );
  }
  const tally = concernTally(plan.commits);
  if (tally !== null) say(tally);
}

/** Runs one command under the session's lock, so two agents never apply or review it at once. */
async function locked<T>(
  session: Session,
  command: string,
  run: (held: HeldLock) => Promise<T>,
): Promise<T> {
  const held = session.lock(command);
  try {
    return await run(held);
  } finally {
    held.release();
  }
}

function splitBranch(session: Session): string {
  return `${session.anchor.branch}-split`;
}

async function apply(cwd: string, args: Args): Promise<number> {
  const session = await openSession(cwd);
  const open = await openOnServer(session, "split");
  if (open !== null) return applyHosted(session, args, open);
  const code = await locked(session, "apply", () => applyLocked(session, args));
  if (code === 0) next("follow-me review");
  return code;
}

/**
 * Applies while the review server hosts the session. The server holds the session lock, so the
 * write runs under it, and the page is then swapped to the new plan version in place.
 */
async function applyHosted(session: Session, args: Args, open: Open): Promise<number> {
  const code = await applyLocked(session, args);
  const latest = session.plans().at(-1);
  if (code !== 0 || latest === undefined) return code;
  if (latest.version === open.summary.version) {
    say(`plan v${latest.version} is already open: ${sessionUrl(open.port, open.summary)}`);
  } else {
    const swapped = await swapVersion(open.port, open.summary, latest.version, latest.hash);
    say(`follow-me review: ${sessionUrl(open.port, swapped)}`);
    say(
      `the page now shows plan v${latest.version}; the comments on v${open.summary.version} are saved`,
    );
  }
  next("follow-me watch");
  return 0;
}

function signMode(args: Args): SignMode {
  const on = args.flags.has("sign");
  const off = args.flags.has("no-sign");
  if (on && off) throw new UsageError("--sign and --no-sign cannot be used together");
  return on ? "on" : off ? "off" : "config";
}

function describeSigning(s: Signing): string {
  return s.on ? `on (${s.format})` : "off";
}

async function applyLocked(session: Session, args: Args): Promise<number> {
  const mode = signMode(args);
  const verdict = validate(session, session.readDraft());
  if (!verdict.ok) return 1;
  const { plan } = verdict;
  const syntax = await checkSyntax(plan, syntaxOverride(args));
  const allowed = args.flags.has("allow-syntax-errors");
  if (syntax.issues.length > 0) {
    for (const line of formatSyntax(syntax, allowed ? "warning: " : "")) say(line);
    if (!allowed) {
      say("refusing to apply: fix the commits above, or pass --allow-syntax-errors");
      return 1;
    }
  }
  const version = session.freeze(plan);
  const name = args.values.get("name") ?? splitBranch(session);
  const signed = await signing(session.root, mode);
  const last = session.applied();
  // Signatures can differ per run, so the record, not SHA equality, decides that nothing changed.
  const recorded =
    last !== null &&
    last.branch === name &&
    last.version === version &&
    last.hash === plan.hash &&
    last.signed === signed.on &&
    (await branchHead(session.root, name)) === last.head;
  const result: Omit<WriteResult, "commits"> = recorded
    ? { kind: "unchanged", branch: name, head: last.head }
    : await writeBranch(session.root, session.diff, plan, {
        name,
        source: session.anchor.branch,
        expectedOld: last?.branch === name ? last.head : null,
        force: args.flags.has("force"),
        sign: signed.on,
      });
  session.recordApplied({ version, hash: plan.hash }, { ...result, signed: signed.on });
  for (const w of verdict.warnings) say(formatWarning(w));
  say(
    `${result.kind} ${result.branch} at ${short(result.head)} from plan v${version} (${plural(plan.commits.length, "commit")})`,
  );
  say(`signing: ${describeSigning(signed)}`);
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

/** Writes the one-commit-per-file draft with no API call and no agent. */
function naive(session: Session, cwd: string, args: Args): number {
  if (args.flags.has("walk") || args.values.has("model")) {
    throw new UsageError("--naive writes no story, so --walk and --model do not apply");
  }
  const draft = naiveDraft(session.diff);
  session.writeDraft(draft);
  const verdict = validate(session, draft);
  if (!verdict.ok) return 1;
  say(
    `wrote ${relative(cwd, session.draftPath)} (${plural(verdict.plan.commits.length, "commit")})`,
  );
  next("follow-me apply");
  return 0;
}

async function plan(cwd: string, args: Args): Promise<number> {
  const session = await openSession(cwd, sessionOpts(args));
  const mode = modeOf(args);
  if (args.flags.has("naive")) return naive(session, cwd, args);
  if ((await draftWithApi(session, cwd, mode, args)) === null) return 1;
  next(mode === "walk" ? `follow-me walk${branchFlag(args)}` : "follow-me apply");
  return 0;
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

type Prepared = { readonly version: PlanVersion; readonly plan: ValidPlan };

function announce(mode: ReviewMode, url: string, args: Args): void {
  say(`follow-me ${mode === "walk" ? "code review" : "review"}: ${url}`);
  if (!args.flags.has("no-open")) openBrowser(url);
}

/** Where a review went: refused before hosting, hosted by another process, or by this one. */
type Hosted =
  | { readonly kind: "refused" }
  | { readonly kind: "elsewhere"; readonly port: number; readonly summary: HostedSummary }
  | { readonly kind: "ended" }
  | { readonly kind: "stopped" };

/** The server that already runs for this user, or one on --port that answers as ours. */
async function runningServer(home: string, port: number | undefined): Promise<number | null> {
  const live = await findServer(home);
  if (live !== null) return live.port;
  if (port !== undefined && (await probeHealth(port)) !== null) return port;
  return null;
}

/**
 * Hosts the session on the user's one review server. A running server gets the session and the
 * CLI exits; otherwise this process becomes the server, in the foreground or, with --detach, as
 * a background process. The CLI prepares the plan under the session lock and hands the lock to
 * whichever process hosts it. report runs when a foreground review ends.
 */
async function hostReview(
  session: Session,
  mode: ReviewMode,
  args: Args,
  prepare: () => Promise<Prepared | null>,
  report: (review: Review) => void,
): Promise<Hosted> {
  const home = stateDir();
  const open = await openOnServer(session, mode);
  if (open !== null) {
    announce(mode, sessionUrl(open.port, open.summary), args);
    return { kind: "elsewhere", ...open };
  }
  return locked(session, mode === "walk" ? "walk" : "review", async (held) => {
    const prepared = await prepare();
    if (prepared === null) return { kind: "refused" };
    const registration: Registration = {
      dir: session.dir,
      mode,
      version: prepared.version,
      hash: prepared.plan.hash,
      lockToken: held.token,
    };
    const port = portOf(args);
    let started: Started;
    const running = await runningServer(home, port);
    if (running !== null) started = { kind: "attached", port: running };
    else if (args.flags.has("detach")) {
      const server = await spawnDetached(home, port);
      if (port !== undefined && server.port !== port) say(portFallbackMessage(port, server.port));
      started = { kind: "attached", port: server.port };
    } else started = await startOrAttach(home, port, say);

    if (started.kind === "attached") {
      const summary = await registerWith(started.port, registration);
      announce(mode, sessionUrl(started.port, summary), args);
      return { kind: "elsewhere", port: started.port, summary };
    }
    const { host } = started;
    const { summary, done } = await host.register(registration);
    announce(mode, sessionUrl(host.port, summary), args);
    const review = await done;
    if (review === null) return { kind: "stopped" };
    report(review);
    const others = host.sessions().length;
    say(
      others > 0
        ? `still serving ${plural(others, "other session")} at ${host.url}; this process exits after they end`
        : `the server exits in ${Math.ceil(idleMs() / 1000)}s unless another review starts; ctrl-c stops it now`,
    );
    await host.closed;
    return { kind: "ended" };
  });
}

function exitCode(hosted: Hosted): number {
  if (hosted.kind === "stopped") {
    console.error("follow-me: the server stopped before the review ended; its comments are kept");
  }
  return hosted.kind === "refused" || hosted.kind === "stopped" ? 1 : 0;
}

function alreadyReviewed(
  session: Session,
  mode: ReviewMode,
  version: PlanVersion,
  args: Args,
): boolean {
  if (!reviewsOf(session, mode).some((r) => r.version === version)) return false;
  const branch = branchFlag(args);
  console.error(
    mode === "walk"
      ? `follow-me: plan v${version} already has a code review; read it with \`follow-me feedback --walk${branch}\``
      : `follow-me: plan v${version} already has a review; read it with \`follow-me feedback${branch}\`, then run \`follow-me split${branch}\` for the next plan`,
  );
  return true;
}

type Open = { readonly port: number; readonly summary: HostedSummary };

/** This session's review, of this mode or any, on the user's server when that holds its lock. */
async function openOnServer(session: Session, mode: ReviewMode | null): Promise<Open | null> {
  const lock = session.lockState();
  const live = await findServer(stateDir());
  if (live === null || lock.kind !== "held" || lock.pid !== live.pid) return null;
  const id = sessionIdOf(session.dir);
  const summary = (await listSessions(live.port)).find(
    (s) => s.id === id && (mode === null || s.mode === mode),
  );
  return summary === undefined ? null : { port: live.port, summary };
}

function timeoutOf(args: Args): number | undefined {
  const raw = args.values.get("timeout");
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new UsageError(`--timeout ${raw} is not a number of seconds`);
  }
  return seconds;
}

/** The reviews in this mode's slot, oldest first. */
function reviewsOf(session: Session, mode: ReviewMode) {
  return mode === "walk" ? session.walkReviews() : session.reviews();
}

function savedReview(session: Session, mode: ReviewMode, version: PlanVersion): Review | null {
  const stored = reviewsOf(session, mode).find((r) => r.version === version);
  return stored?.review ?? null;
}

/**
 * Polls the server until it no longer hosts the session, then reads the review it saved. Null
 * when the server stopped without one; "timeout" when the review is still open at the deadline.
 */
async function waitForEnd(
  session: Session,
  hosted: { readonly port: number; readonly summary: HostedSummary },
  timeout: number | undefined,
): Promise<Review | null | "timeout"> {
  const deadline = timeout === undefined ? Number.POSITIVE_INFINITY : Date.now() + timeout * 1000;
  while (await stillHosted(hosted.port, hosted.summary)) {
    if (Date.now() >= deadline) return "timeout";
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return savedReview(session, hosted.summary.mode, hosted.summary.version);
}

function reportSplit(review: Review): void {
  say(`review v${review.planVersion} saved with ${plural(review.comments.length, "comment")}`);
  next("follow-me feedback");
}

function prepareSplit(session: Session, args: Args): () => Promise<Prepared | null> {
  return async () => {
    const latest = latestPlan(session);
    if (latest === null || alreadyReviewed(session, "split", latest.version, args)) return null;
    return latest;
  };
}

async function review(cwd: string, args: Args): Promise<number> {
  const session = await openSession(cwd);
  const timeout = timeoutOf(args);
  if (timeout !== undefined && !args.flags.has("wait")) {
    throw new UsageError("--timeout only applies with --wait");
  }
  const hosted = await hostReview(session, "split", args, prepareSplit(session, args), reportSplit);
  if (hosted.kind !== "elsewhere") return exitCode(hosted);
  if (!args.flags.has("wait")) {
    next("end the review on the page, then follow-me feedback");
    return 0;
  }
  const ended = await waitForEnd(session, hosted, timeout);
  if (ended === "timeout") {
    console.error(
      `follow-me: the review is still open after ${timeout}s; run \`follow-me review --wait\` again to keep waiting`,
    );
    return 1;
  }
  if (ended === null) return exitCode({ kind: "stopped" });
  reportSplit(ended);
  return 0;
}

/** Why split needs a new draft before it can go on, or null when draft.json is ready. */
function draftNeed(session: Session, cwd: string, args: Args): string | null | "invalid" {
  let draft: unknown;
  try {
    draft = session.readDraft();
  } catch (error) {
    if (error instanceof MissingDraftError) return `no draft for ${session.anchor.branch} yet`;
    throw error;
  }
  const verdict = validatePlan(session.diff, draft, { lastReview: session.lastReview() });
  if (!verdict.ok) {
    if (verdict.issues.some((issue) => issue.kind === "stale")) {
      return `the draft for ${session.anchor.branch} was written for an older tip`;
    }
    for (const issue of verdict.issues) say(formatIssue(issue));
    next(`fix ${relative(cwd, session.draftPath)}, then follow-me split${branchFlag(args)}`);
    return "invalid";
  }
  const { hash } = verdict.plan;
  const reviewed = session
    .plans()
    .find((p) => p.hash === hash && session.reviews().some((r) => r.version === p.version));
  if (reviewed !== undefined) {
    return `plan v${reviewed.version} of ${session.anchor.branch} already has a review and needs a new draft that answers it`;
  }
  listPlan(verdict.plan);
  return null;
}

/** Writes the prompt for an agent and prints what to tell it and what to run after. */
function handOff(session: Session, cwd: string, args: Args, why: string): void {
  session.writePrompt(renderPrompt(promptInput(session, "split", args)));
  const prompt = relative(cwd, session.promptPath);
  say(
    `${why}, and neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set to ask the API for one.`,
  );
  say(
    `Have your coding agent follow ${prompt} and write ${relative(cwd, session.draftPath)}, then run:`,
  );
  say(`  follow-me check${branchFlag(args)}`);
  say(`  follow-me split${branchFlag(args)}`);
  next(`hand ${prompt} to your agent`);
}

/**
 * The author's one command: extract, draft through the API when it can, apply, and open the
 * review on the user's server. It stops with a handoff whenever an agent has to write the draft.
 */
async function split(cwd: string, args: Args): Promise<number> {
  const session = await openFresh(cwd, args);
  say(headline(session));
  const open = await openOnServer(session, "split");
  if (open !== null) {
    announce("split", sessionUrl(open.port, open.summary), args);
    next("end the review on the page, then follow-me feedback");
    return 0;
  }
  const need = draftNeed(session, cwd, args);
  if (need === "invalid") return 1;
  if (need !== null) {
    if (!hasApiCredentials()) {
      handOff(session, cwd, args, need);
      return 1;
    }
    say(`${need}; asking the Anthropic API for one`);
    const drafted = await draftWithApi(session, cwd, "split", args);
    if (drafted === null) return 1;
    listPlan(drafted);
  }
  const applied = await locked(session, "apply", () => applyLocked(session, args));
  if (applied !== 0) return applied;
  const detached = { ...args, flags: new Set([...args.flags, "detach"]) };
  const hosted = await hostReview(
    session,
    "split",
    detached,
    prepareSplit(session, args),
    reportSplit,
  );
  if (hosted.kind !== "elsewhere") return exitCode(hosted);
  next("end the review on the page, then follow-me feedback");
  return 0;
}

/** Opens the session, re-extracting instead of failing when the branch moved or --base changed. */
async function openFresh(cwd: string, args: Args): Promise<Session> {
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
function walkablePlan(session: Session): Prepared | null {
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
  const session = await openFresh(cwd, args);
  const report = (review: Review) => {
    const saved = join(session.reviewsDir("walk"), `v${review.planVersion}.json`);
    say(
      `code review saved to ${relative(cwd, saved)} with ${plural(review.comments.length, "comment")}`,
    );
    next(
      `follow-me feedback --walk${branchFlag(args)}, which prints it as a code review for the author`,
    );
  };
  const hosted = await hostReview(
    session,
    "walk",
    args,
    () => walkPlan(session, cwd, args),
    report,
  );
  if (hosted.kind === "elsewhere") {
    next(`end the code review on the page, then follow-me feedback --walk${branchFlag(args)}`);
  }
  return exitCode(hosted);
}

async function walkPlan(session: Session, cwd: string, args: Args): Promise<Prepared | null> {
  let latest = walkablePlan(session);
  if (latest === null) {
    if (!hasApiCredentials()) {
      say(
        `no plan for ${session.anchor.branch} yet, and neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set to ask the API for one.`,
      );
      say("Have a coding agent follow the prompt, then walk again:");
      say(`  follow-me prompt --walk${branchFlag(args)}`);
      say(`  follow-me walk${branchFlag(args)}`);
      return null;
    }
    const drafted = await draftWithApi(session, cwd, "walk", args);
    if (drafted === null) return null;
    latest = { version: session.freeze(drafted), plan: drafted };
  }
  return alreadyReviewed(session, "walk", latest.version, args) ? null : latest;
}

/** The consolidated report of a saved review, or null after saying why it cannot be rendered. */
function renderStored(session: Session, stored: StoredReview): string | null {
  const plan = session.plans().find((p) => p.version === stored.version);
  if (plan === undefined) {
    console.error(`follow-me: review v${stored.version} refers to a plan that is missing`);
    return null;
  }
  const verdict = validatePlan(session.diff, serializePlanFile(plan.file));
  if (!verdict.ok) {
    console.error(`follow-me: plan v${plan.version} no longer fits ${session.anchor.branch}`);
    return null;
  }
  // Later plans answer this review's questions.
  const responses = session
    .plans()
    .filter((p) => p.version > stored.version)
    .flatMap((p) => p.file.responses);
  return renderReport(stored.review, verdict.plan.commits, session.diff.units, {
    branch: session.anchor.branch,
    responses,
  });
}

async function feedback(cwd: string, args: Args): Promise<number> {
  const session = await openSession(cwd, sessionOpts(args));
  const walk = args.flags.has("walk");
  const walks = session.walkReviews();
  const stored = walk ? walks.at(-1) : session.reviews().findLast((r) => r.review.mode === "split");
  if (stored === undefined) {
    const branch = branchFlag(args);
    console.error(
      walk
        ? `follow-me: no code review yet, run \`follow-me walk${branch}\` first`
        : walks.length > 0
          ? `follow-me: no plan review yet; \`follow-me feedback --walk${branch}\` prints the code review`
          : "follow-me: no review yet, run `follow-me review` first",
    );
    return 1;
  }
  const text = renderStored(session, stored);
  if (text === null) return 1;
  process.stdout.write(text);
  say();
  next(
    stored.review.mode === "walk"
      ? "hand this to the branch's author"
      : `hand this to your agent, then follow-me check${branchFlag(args)}`,
  );
  return 0;
}

/** The consolidated report of the hosted review as it stands, else of the last one that ended. */
async function report(cwd: string, args: Args): Promise<number> {
  const session = await openSession(cwd, sessionOpts(args));
  const open = await openOnServer(session, null);
  if (open !== null) {
    process.stdout.write(await fetchReport(open.port, open.summary));
    return 0;
  }
  const ended = [...session.reviews(), ...session.walkReviews()].sort((a, b) =>
    a.review.endedAt.localeCompare(b.review.endedAt),
  );
  const stored = ended.at(-1);
  if (stored === undefined) {
    console.error("follow-me: no review is open and none has ended; run `follow-me review` first");
    return 1;
  }
  const text = renderStored(session, stored);
  if (text === null) return 1;
  process.stdout.write(text);
  return 0;
}

/** Events the reviewer caused; the agent's own replies and version swaps are not news to it. */
function isNews(event: ServerEvent): boolean {
  if (event.type === "version") return false;
  return !(event.type === "reply" && event.reply.author === "agent");
}

const POLL_MS = 25_000;
const DEFAULT_WATCH_SECONDS = 90;

function notOpen(session: Session): number {
  console.error(
    `follow-me: ${session.anchor.branch} is not open on the review server; run \`follow-me review\` first`,
  );
  return 1;
}

/**
 * Waits for the reviewer to do something on the hosted page and prints it. Exits 0 with the first
 * batch, or 2 with nothing at the timeout. The log is the server's, so nothing is read from files.
 */
async function watch(cwd: string, args: Args): Promise<number> {
  const session = await openSession(cwd, sessionOpts(args));
  const open = await openOnServer(session, null);
  if (open === null) return notOpen(session);
  const sinceRaw = args.values.get("since");
  let since = sinceRaw === undefined ? 0 : Number(sinceRaw);
  if (!Number.isInteger(since) || since < 0) {
    throw new UsageError(`--since ${sinceRaw} is not an event number`);
  }
  if (args.flags.has("follow")) {
    let ended = false;
    await followEvents(open.port, open.summary, since, (event) => {
      if (event.type === "ended") ended = true;
      if (!isNews(event)) return;
      if (args.flags.has("json")) say(JSON.stringify(event));
      else process.stdout.write(renderEvents([event]));
    });
    if (ended) return 0;
    console.error("follow-me: the event stream closed before the review ended");
    return 1;
  }
  const deadline = Date.now() + (timeoutOf(args) ?? DEFAULT_WATCH_SECONDS) * 1000;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) {
      console.error(`follow-me: nothing new on the review page since event ${since}`);
      return 2;
    }
    const batch = await pollEvents(open.port, open.summary, since, Math.min(left, POLL_MS));
    since = batch.seq;
    const news = batch.events.filter(isNews);
    if (news.length === 0) continue;
    if (args.flags.has("json")) for (const event of news) say(JSON.stringify(event));
    else {
      process.stdout.write(renderEvents(news));
      next(
        news.some((e) => e.type === "ended")
          ? "follow-me report"
          : `follow-me reply <comment> --body <text>, or write a new draft and apply; then follow-me watch --since ${since}`,
      );
    }
    return 0;
  }
}

/** Posts the agent's answer under a comment on the hosted page. */
async function reply(cwd: string, args: Args): Promise<number> {
  const [commentId, extra] = args.positionals;
  const body = args.values.get("body");
  if (commentId === undefined || extra !== undefined || body === undefined) {
    throw new UsageError("usage: follow-me reply <commentId> --body <text> [--diagram <file>]");
  }
  const diagramFile = args.values.get("diagram");
  let diagram: string | undefined;
  if (diagramFile !== undefined) {
    try {
      diagram = readFileSync(diagramFile, "utf8");
    } catch (error) {
      throw new UsageError(
        `cannot read ${diagramFile}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  const session = await openSession(cwd, sessionOpts(args));
  const open = await openOnServer(session, null);
  if (open === null) return notOpen(session);
  const id = await postReply(open.port, open.summary, commentId, {
    author: "agent",
    body,
    ...(diagram === undefined ? {} : { diagram }),
  });
  say(`replied ${id} to ${commentId}`);
  next("follow-me watch");
  return 0;
}

function describeLock(lock: LockState): string {
  if (lock.kind === "free") return "free";
  const who = `pid ${lock.pid} (follow-me ${lock.command})`;
  return lock.kind === "held"
    ? `held by ${who}`
    : `stale, ${who} is gone; follow-me clean removes it`;
}

/** The URL of this session on the user's server, when that server is what holds its lock. */
async function hostedPage(session: Session, holder: number): Promise<string | null> {
  const live = await findServer(stateDir());
  if (live === null || live.pid !== holder) return null;
  const id = sessionIdOf(session.dir);
  const open = (await listSessions(live.port)).find((s) => s.id === id);
  return open === undefined ? null : sessionUrl(live.port, open);
}

async function serverCommand(argv: readonly string[]): Promise<number> {
  const [verb, ...rest] = argv;
  const home = stateDir();
  switch (verb) {
    case "status": {
      parseArgs(rest, {});
      const live = await findServer(home);
      if (live === null) {
        say("no server running");
        return 0;
      }
      say(`server pid ${live.pid} at http://127.0.0.1:${live.port}/ since ${live.startedAt}`);
      const sessions = await listSessions(live.port);
      if (sessions.length === 0) say("  no sessions");
      for (const s of sessions) {
        const what = s.mode === "walk" ? "walk" : "review";
        say(
          `  ${sessionUrl(live.port, s)}  ${s.branch} ${what} of plan v${s.version}, ${plural(s.comments, "comment")}  ${s.repo}`,
        );
      }
      return 0;
    }
    case "stop": {
      parseArgs(rest, {});
      const stopped = await stopServer(home);
      say(stopped === null ? "no server running" : `stopped server pid ${stopped.pid}`);
      return 0;
    }
    // What `--detach` runs in the background; not meant to be typed.
    case "run": {
      const started = await startOrAttach(home, portOf(parseArgs(rest, { values: ["port"] })), say);
      if (started.kind === "attached") {
        say(`a follow-me server already runs on port ${started.port}`);
        return 0;
      }
      say(`follow-me server: ${started.host.url}`);
      await started.host.closed;
      return 0;
    }
    default:
      throw new UsageError("usage: follow-me server status|stop");
  }
}

async function status(cwd: string): Promise<number> {
  const session = await openSession(cwd);
  const { anchor, diff } = session;
  const plans = session.plans();
  const reviews = session.reviews().filter((r) => r.review.mode === "split");
  const walks = session.walkReviews();
  say(`${anchor.branch} ${short(anchor.tip)} onto ${anchor.baseRef} ${short(anchor.base)}`);
  say(`writes to: ${splitBranch(session)}`);
  const lock = session.lockState();
  say(`lock: ${describeLock(lock)}`);
  const page = lock.kind === "held" ? await hostedPage(session, lock.pid) : null;
  if (page !== null) say(`review page: ${page}`);
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
  if (walks.length > 0) {
    const latest = walks.at(-1)?.review.comments.length ?? 0;
    say(
      `code reviews: ${walks.map((r) => `v${r.version}`).join(", ")} (latest has ${plural(latest, "comment")})`,
    );
  }
  say(`signing: ${describeSigning(await signing(session.root, "config"))}`);
  const applied = session.applied();
  say(
    applied === null
      ? "applied: never"
      : `applied: plan v${applied.version} as ${applied.branch} at ${short(applied.head)}`,
  );
  return 0;
}

function skillTargets(args: Args): SkillTargets {
  return {
    harness: args.values.get("harness"),
    all: args.flags.has("all"),
    project: args.flags.has("project"),
    dryRun: args.flags.has("dry-run"),
  };
}

function missingDraft(error: MissingDraftError, cwd: string): string {
  return `no draft at ${relative(cwd, error.path)} yet; your coding agent writes it from \`follow-me prompt\`, or \`follow-me plan\` has the Anthropic API write it`;
}

export async function main(argv: readonly string[], cwd: string): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "extract": {
        const args = parseArgs(rest, { values: ["base", "branch"] });
        summarize(await extractSession(cwd, sessionOpts(args)), cwd);
        const branch = branchFlag(args);
        next(`follow-me prompt${branch}, or follow-me plan${branch} with an Anthropic key`);
        return 0;
      }
      case "check":
        return await check(cwd, parseArgs(rest, { values: ["branch", "syntax"] }));
      case "apply":
        return await apply(
          cwd,
          parseArgs(rest, {
            values: ["name", "syntax"],
            flags: ["force", "sign", "no-sign", "allow-syntax-errors"],
          }),
        );
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
        return await plan(
          cwd,
          parseArgs(rest, { values: ["model", "branch"], flags: ["walk", "naive"] }),
        );
      case "split": {
        const spec = {
          values: ["base", "branch", "model", "syntax"],
          flags: ["no-open", "allow-syntax-errors"],
        };
        return await split(cwd, parseArgs(rest, spec));
      }
      case "review": {
        const spec = { values: ["port", "timeout"], flags: ["no-open", "detach", "wait"] };
        return await review(cwd, parseArgs(rest, spec));
      }
      case "walk": {
        const spec = { values: ["base", "branch", "model", "port"], flags: ["no-open", "detach"] };
        return await walk(cwd, parseArgs(rest, spec));
      }
      case "server":
        return await serverCommand(rest);
      case "feedback":
        return await feedback(cwd, parseArgs(rest, { values: ["branch"], flags: ["walk"] }));
      case "watch": {
        const spec = { values: ["since", "timeout", "branch"], flags: ["json", "follow"] };
        return await watch(cwd, parseArgs(rest, spec));
      }
      case "reply":
        return await reply(cwd, parseArgs(rest, { values: ["body", "diagram", "branch"] }));
      case "report":
        return await report(cwd, parseArgs(rest, { values: ["branch"] }));
      case "clean": {
        const args = parseArgs(rest, { flags: ["all", "dry-run"] });
        const opts = { all: args.flags.has("all"), dryRun: args.flags.has("dry-run") };
        for (const path of await cleanSessions(cwd, opts)) say(relative(cwd, path));
        return 0;
      }
      case "install": {
        const args = parseArgs(rest, {
          values: ["harness"],
          flags: ["all", "project", "dry-run", "list"],
        });
        return runInstall(
          { ...skillTargets(args), list: args.flags.has("list") },
          homedir(),
          cwd,
          say,
        );
      }
      case "uninstall": {
        const args = parseArgs(rest, { values: ["harness"], flags: ["all", "project", "dry-run"] });
        return runUninstall(skillTargets(args), homedir(), cwd, say);
      }
      case undefined:
      case "help":
      case "-h":
      case "--help":
        say(USAGE);
        return command === undefined ? 1 : 0;
      case "-v":
      case "--version":
        say(`follow-me ${version()}`);
        return 0;
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
      RegistrationError,
      GitError,
      PlanRequestError,
      NotARepositoryError,
    ];
    if (error instanceof MissingDraftError) {
      console.error(`follow-me: ${missingDraft(error, cwd)}`);
    } else if (error instanceof DiffParseError) {
      console.error(`follow-me: could not parse the diff, please report this: ${error.message}`);
    } else if (error instanceof Error && known.some((k) => error instanceof k)) {
      console.error(`follow-me: ${error.message}`);
    } else console.error(error);
    return 1;
  }
}
