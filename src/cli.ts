import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  changedLines,
  LcovError,
  type NamedTest,
  parseLcov,
  parseLocArg,
  recordRun,
  runOf,
  tipPlacer,
  totalOf,
} from "./coverage.ts";
import { definitionIndex, isIdentifier } from "./definition.ts";
import { DiffParseError, formatUnitRef, isUnitId } from "./diff.ts";
import {
  BranchRefusedError,
  branchHead,
  GitError,
  isOwnWork,
  pathsAt,
  pathsChanged,
  type Signing,
  type SignMode,
  signing,
  treeOf,
  type WriteResult,
  writeBranch,
} from "./git.ts";
import {
  fetchCarried,
  fetchComments,
  fetchReport,
  fetchWaitingOffers,
  findServer,
  followEvents,
  idleMs,
  listSessions,
  openBrowser,
  pollEvents,
  portFallbackMessage,
  postComment,
  postCoverage,
  postReply,
  probeHealth,
  readServerRecord,
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
import {
  findSkillDir,
  InstallError,
  runInstall,
  runUninstall,
  type SkillTargets,
  syncSkills,
} from "./install.ts";
import { naiveDraft } from "./naive.ts";
import {
  isCommentId,
  isConcernId,
  isFields,
  OFFERS_PER_COMMIT,
  OFFERS_PER_PLAN,
  serializePlanFile,
  type ValidPlan,
  validatePlan,
} from "./plan.ts";
import {
  type Changes,
  type PromptInput,
  renderEvents,
  renderPrompt,
  renderReport,
  renderShownComment,
  renderShownConcern,
  renderShownDefinitions,
  renderShownUnit,
  reportItems,
} from "./prompt.ts";
import { type Registration, RegistrationError, sessionIdOf } from "./server.ts";
import {
  BranchMovedError,
  cleanSessions,
  coverageAt,
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
  sessionComments,
  sinceLastPlan,
} from "./session.ts";
import { checkSyntax, type SyntaxReport } from "./syntax.ts";
import type {
  Comment,
  Diff,
  HostedSummary,
  PlanIssue,
  PlanVersion,
  PlanWarning,
  ProjectedCommit,
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

/** A test run follow-me will not record, with the reason the agent can act on. */
class CoverageError extends Error {
  override readonly name = "CoverageError";
}

const SHORT_USAGE = `usage: follow-me [--wait <seconds>] [--branch <name>]

Run follow-me with no command. Each call does the next thing that is missing and returns: it
writes the prompt for you to answer, reports what is wrong with your draft, opens the review for
the user, then listens to them for up to --wait seconds (default 90, at most 300, 0 for none) and
prints what they flagged or asked. It is interactive: do what its "next:" line says and run it
again until it prints the report.

Other commands:
  reply <commentId> --body <text> [--diagram <file>]
                                            answer under a comment on the page; the diagram is
                                            Mermaid source
  explain [--commit <n>] [--unit <id>] [--lines <a-b>] --body <text> [--diagram <file>]
                                            start a thread on the page without being asked
  show <h_…|c_…|k_…|path:line[@n|@base]|name>
                                            print a unit, a comment's thread, a concern, the
                                            lines around path:line in commit n, or where a name
                                            is defined, instead of reading files
  report [--json] [--markdown]              print the report of the latest review; --json lists
                                            the items to post to a merge request
  coverage <lcov> [--test <id> [--at <path:line>]]
                                            record a test run taken at the tip for the page

help --all lists every command.`;

const USAGE = `usage: follow-me <command> [options]

follow-me with no command is the entry point; see \`follow-me help\`. The commands below are what it
runs, for when you want one step by hand.

Split your own branch:
  split [--base <ref>] [--branch <name>] [--no-open]
                                            extract, apply your agent's draft and open the
                                            review in one go; without a valid draft it writes
                                            the prompt for your agent and stops
  extract [--base <ref>] [--branch <name>]  anchor a session and list the units
  prompt [--walk] [--branch <name>]         print the planner prompt; your coding agent
                                            writes draft.json from it
  plan --naive [--branch <name>]            no agent: one "wip: <path>" commit per touched
                                            file, in diff order
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
  review [--base <ref>] [--branch <name>] [--port <n>] [--detach] [--no-open]
         [--wait [--timeout <seconds>]]     open the review, commit by commit; --wait returns
                                            only once the review ends. After apply it reviews
                                            your split; otherwise it plans for a reader and
                                            reviews the code, applying nothing
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
  explain [--commit <n>] [--unit <id>] [--lines <a-b>] --body <text> [--diagram <file>]
                                            start a thread on the page without being asked;
                                            --lines are change lines of the unit, commits count
                                            from 1; with no target it is about the whole plan.
                                            watch leaves these out like your replies
  show <h_…|c_…|k_…|path:line[@n|@base]|name> [--branch <name>]
                                            print a unit with the commits that take it, a
                                            comment with its rows and thread, a concern with its
                                            lines, the lines around path:line at the tip, in
                                            commit n of the plan, or in the base, or each place
                                            a name is defined at the tip with the commit it
                                            lands in
  report [--json] [--markdown] [--branch <name>]
                                            print the report of the open review, or of the last
                                            one that ended. Markdown lists issues by file and
                                            line in both voices, then questions with answers;
                                            --json lists the items to post to a merge request
                                            (path, lines, severity, body, thread, excluded)
  coverage <lcov> [--test <id> [--at <path:line>]] [--branch <name>]
                                            record the lcov of a test run at the branch tip;
                                            refuses when a covered file in the working tree
                                            differs from the tip. A plain run replaces the last;
                                            --test runs add one test each, --at is where it is
  apply, while the page is open, swaps it to the new plan version in place, same URL.

Old names, still working:
  walk                                      is review; prints one line saying so
  feedback [--walk]                         is report; prints one line saying so

Review server:
  server status                             show the review server and the sessions it hosts
  server stop                               stop the review server; drafts are kept

Setup:
  install [--harness <ids>|--all] [--project] [--dry-run]
                                            copy the skill into coding agents' skill dirs
  install --list                            show each harness, its skill dirs and docs
  uninstall [--harness <ids>|--all] [--project] [--dry-run]
                                            remove the skill files install writes
  upgrade [--harness <ids>|--all] [--project] [--dry-run]
                                            update the package with npm, then refresh the
                                            installed skill copies
  clean [--all] [--dry-run]                 remove sessions of deleted branches, finished
                                            review drafts and leftovers of dead processes;
                                            --all removes .follow-me/ entirely
  --version                                 print the version
  help                                      print this

--walk writes the prompt for a reviewer: a story with notes instead of a split.
review shares one server per user: a running one hosts the session and the command
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
    case "bad-offer":
      return `$.commits[${issue.commit}]: offer: ${issue.reason}`;
    case "too-many-offers":
      return issue.commit === null
        ? `the plan has ${issue.count} offers; at most ${OFFERS_PER_PLAN}, and most plans need none`
        : `$.commits[${issue.commit}] has ${issue.count} offers; at most ${OFFERS_PER_COMMIT} per commit`;
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
  rememberPort(session, open.port);
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
  next(`run follow-me again; ${STILL_WORKING}`);
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

function promptInput(
  session: Session,
  mode: ReviewMode,
  args: Args,
  changes?: Changes,
): PromptInput {
  const common = {
    diff: session.diff,
    draftPath: session.draftPath,
    checkCommand: `follow-me check${branchFlag(args)}`,
    ...skillFile(),
    ...(changes === undefined ? {} : { changes }),
  };
  if (mode === "walk") return { ...common, mode };
  const previous = session.plans().at(-1);
  return {
    ...common,
    mode,
    previousPlan: previous?.file ?? null,
    review: session.lastReview(),
    previousCommits: previous === undefined ? [] : projectedCommits(session, previous.version),
  };
}

/** The skill this package ships, which holds the rules prompt.md points at; none if it is missing. */
function skillFile(): { skillPath?: string } {
  try {
    return { skillPath: join(findSkillDir(), "SKILL.md") };
  } catch (error) {
    if (error instanceof InstallError) return {};
    throw error;
  }
}

/** The commits of a frozen plan as projected now, or none when it no longer fits the branch. */
function projectedCommits(session: Session, version: PlanVersion): readonly ProjectedCommit[] {
  const plan = session.plans().find((p) => p.version === version);
  if (plan === undefined) return [];
  const verdict = validatePlan(session.diff, serializePlanFile(plan.file));
  return verdict.ok ? verdict.plan.commits : [];
}

/** Writes the one-commit-per-file draft with no agent. */
function naive(session: Session, cwd: string, args: Args): number {
  if (args.flags.has("walk")) {
    throw new UsageError("--naive writes no story, so --walk does not apply");
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
  if (!args.flags.has("naive")) {
    console.error(
      "follow-me plan: there is no built-in model planner; your coding agent writes the draft from `follow-me prompt`, or use --naive for one commit per file",
    );
    return 1;
  }
  return naive(await openSession(cwd, sessionOpts(args)), cwd, args);
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

function announce(url: string, args: Args): void {
  say(`follow-me review: ${url}`);
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
    rememberPort(session, open.port);
    announce(sessionUrl(open.port, open.summary), args);
    return { kind: "elsewhere", ...open };
  }
  return locked(session, "review", async (held) => {
    const prepared = await prepare();
    if (prepared === null) return { kind: "refused" };
    const registration: Registration = {
      dir: session.dir,
      mode,
      version: prepared.version,
      hash: prepared.plan.hash,
      lockToken: held.token,
    };
    const port = portOf(args) ?? rememberedPort(session);
    let started: Started;
    const running = await runningServer(home, port);
    if (running !== null) started = { kind: "attached", port: running };
    else if (args.flags.has("detach")) {
      const server = await spawnDetached(home, port);
      if (port !== undefined && server.port !== port) say(portFallbackMessage(port, server.port));
      started = { kind: "attached", port: server.port };
    } else started = await startOrAttach(home, port, say);

    rememberPort(session, started.kind === "attached" ? started.port : started.host.port);
    if (started.kind === "attached") {
      const summary = await registerWith(started.port, registration);
      announce(sessionUrl(started.port, summary), args);
      return { kind: "elsewhere", port: started.port, summary };
    }
    const { host } = started;
    const { summary, done } = await host.register(registration);
    announce(sessionUrl(host.port, summary), args);
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

function alreadyReviewed(session: Session, version: PlanVersion, args: Args): boolean {
  if (!reviewsOf(session).some((r) => r.version === version)) return false;
  console.error(
    `follow-me: plan v${version} already has a review; read it with \`follow-me report${branchFlag(args)}\``,
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
  if (summary === undefined) return null;
  rememberPort(session, live.port);
  return { port: live.port, summary };
}

/**
 * The session's review after its server died: the lock still names the dead server. A fresh
 * server takes the port the old one had, so the open page's origin stays valid and it reconnects;
 * the session registers again from disk, where the page autosaved everything. Null when the
 * session was not hosted by a dead server or its review already ended.
 */
async function revive(session: Session): Promise<Open | null> {
  const home = stateDir();
  const record = readServerRecord(home);
  const lock = session.lockState();
  if (record === null || lock.kind !== "stale" || lock.pid !== record.pid) return null;
  const latest = session.plans().at(-1);
  if (latest === undefined || reviewsOf(session).some((r) => r.version === latest.version)) {
    return null;
  }
  const server = (await findServer(home)) ?? (await spawnDetached(home, record.port));
  const registration: Registration = {
    dir: session.dir,
    mode: reviewMode(session),
    version: latest.version,
    hash: latest.hash,
    lockToken: null,
  };
  let summary: HostedSummary;
  try {
    summary = await registerWith(server.port, registration);
  } catch (error) {
    if (error instanceof RegistrationError) return null;
    throw error;
  }
  rememberPort(session, server.port);
  say("review server restarted, nothing lost");
  if (server.port !== record.port) {
    say(portFallbackMessage(record.port, server.port));
    say(`follow-me review: ${sessionUrl(server.port, summary)}`);
    say("the open page cannot follow it to the new port; reopen it at that URL");
  }
  return { port: server.port, summary };
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

/** Every finished review, oldest first, including reviewer reviews older builds stored apart. */
function reviewsOf(session: Session): StoredReview[] {
  const seen = new Set<PlanVersion>();
  return [...session.reviews(), ...session.walkReviews()]
    .filter((r) => !seen.has(r.version) && seen.add(r.version))
    .sort((a, b) => a.version - b.version);
}

function savedReview(session: Session, version: PlanVersion): Review | null {
  return reviewsOf(session).find((r) => r.version === version)?.review ?? null;
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
  return savedReview(session, hosted.summary.version);
}

function reportSaved(review: Review): void {
  say(`review v${review.planVersion} saved with ${plural(review.comments.length, "comment")}`);
  next("follow-me report");
}

function prepareSplit(session: Session, args: Args): () => Promise<Prepared | null> {
  return async () => {
    const latest = latestPlan(session);
    if (latest === null || alreadyReviewed(session, latest.version, args)) return null;
    return latest;
  };
}

/**
 * Author mode when a split branch was applied for the latest plan: the plan is the author's own
 * and the review is of it. Otherwise the reader is a reviewer meeting the branch, so the plan only
 * orders the reading and nothing is applied. The wire keeps calling that mode "walk".
 */
function reviewMode(session: Session): ReviewMode {
  const applied = session.applied();
  const latest = session.plans().at(-1);
  return applied !== null && latest !== undefined && applied.version === latest.version
    ? "split"
    : "walk";
}

/** Hosts the review of the session: the plan for its author, or the code for a reviewer. */
async function review(cwd: string, args: Args): Promise<number> {
  const session = await openFresh(cwd, args);
  const timeout = timeoutOf(args);
  if (timeout !== undefined && !args.flags.has("wait")) {
    throw new UsageError("--timeout only applies with --wait");
  }
  const open = await openOnServer(session, null);
  const mode = open?.summary.mode ?? reviewMode(session);
  const prepare = mode === "split" ? prepareSplit(session, args) : () => walkPlan(session, args);
  const hosted = await hostReview(session, mode, args, prepare, reportSaved);
  if (hosted.kind !== "elsewhere") return exitCode(hosted);
  if (!args.flags.has("wait")) {
    next("end the review on the page, then follow-me report");
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
  reportSaved(ended);
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
  say(`${why}.`);
  say(
    `Have your coding agent follow ${prompt} and write ${relative(cwd, session.draftPath)}, then run:`,
  );
  say(`  follow-me check${branchFlag(args)}`);
  say(`  follow-me split${branchFlag(args)}`);
  next(`hand ${prompt} to your agent`);
}

/**
 * The author's one command: extract, apply the agent's draft, and open the review on the user's
 * server. It stops with a handoff whenever there is no valid draft.
 */
async function split(cwd: string, args: Args): Promise<number> {
  const session = await openFresh(cwd, args);
  say(headline(session));
  const open = await openOnServer(session, "split");
  if (open !== null) {
    rememberPort(session, open.port);
    announce(sessionUrl(open.port, open.summary), args);
    next("end the review on the page, then follow-me report");
    return 0;
  }
  const need = draftNeed(session, cwd, args);
  if (need === "invalid") return 1;
  if (need !== null) {
    handOff(session, cwd, args, need);
    return 1;
  }
  const applied = await locked(session, "apply", () => applyLocked(session, args));
  if (applied !== 0) return applied;
  const detached = { ...args, flags: new Set([...args.flags, "detach"]) };
  const hosted = await hostReview(
    session,
    "split",
    detached,
    prepareSplit(session, args),
    reportSaved,
  );
  if (hosted.kind !== "elsewhere") return exitCode(hosted);
  next("end the review on the page, then follow-me report");
  return 0;
}

/** The mode a bare `follow-me` works in: a split already applied, else whoever wrote the branch. */
async function entryMode(session: Session, args: Args): Promise<ReviewMode> {
  if (args.flags.has("author") && args.flags.has("reviewer")) {
    throw new UsageError("--author and --reviewer cannot be used together");
  }
  if (args.flags.has("reviewer")) return "walk";
  if (args.flags.has("author")) return "split";
  if (reviewMode(session) === "split") return "split";
  return (await isOwnWork(session.root, session.anchor.base, session.anchor.tip))
    ? "split"
    : "walk";
}

/** What the draft on disk amounts to for the branch as it is now. */
type DraftState =
  | { readonly kind: "missing" }
  | { readonly kind: "stale" }
  | { readonly kind: "invalid" }
  | { readonly kind: "valid"; readonly prepared: ValidPlan };

function draftState(session: Session): DraftState {
  let draft: unknown;
  try {
    draft = session.readDraft();
  } catch (error) {
    if (error instanceof MissingDraftError) return { kind: "missing" };
    throw error;
  }
  const verdict = validatePlan(session.diff, draft, { lastReview: session.lastReview() });
  if (verdict.ok) return { kind: "valid", prepared: verdict.plan };
  if (verdict.issues.some((issue) => issue.kind === "stale")) return { kind: "stale" };
  for (const issue of verdict.issues) say(formatIssue(issue));
  return { kind: "invalid" };
}

/** The newest review of a plan that still fits the branch, or null. */
function reviewedPlan(session: Session): StoredReview | null {
  const reviews = reviewsOf(session);
  for (const stored of reviews.toReversed()) {
    const plan = session.plans().find((p) => p.version === stored.version);
    if (plan !== undefined && validatePlan(session.diff, serializePlanFile(plan.file)).ok) {
      return stored;
    }
  }
  return null;
}

/** Prints the finished review's report, which is what the agent works from from here on. */
async function finished(session: Session, stored: StoredReview): Promise<number> {
  const text = await renderStored(session, stored);
  if (text === null) return 1;
  // A review that swapped versions holds what its earlier versions said too.
  const said = stored.review.comments.length + (stored.review.carried?.length ?? 0);
  say(`review v${stored.version} ended with ${plural(said, "comment")}`);
  process.stdout.write(text);
  say();
  next("done; the user can port it with follow-me report --json");
  return 0;
}

type Moved = NonNullable<Awaited<ReturnType<typeof sinceLastPlan>>>;

/** Whether draft.json was written for the branch's current tip; a missing draft was not. */
function draftForTip(session: Session): boolean {
  try {
    const raw = session.readDraft();
    return (
      typeof raw === "object" && raw !== null && "tip" in raw && raw.tip === session.anchor.tip
    );
  } catch (error) {
    if (error instanceof MissingDraftError) return false;
    throw error;
  }
}

/**
 * The branch moved after the latest plan. The first call writes that plan carried over to the new
 * tip as draft.json; while the draft does not validate, each call writes the prompt with what
 * changed and hands off. Null when the draft is ready, so the entry applies it as usual.
 */
function evolveHandoff(
  session: Session,
  cwd: string,
  mode: ReviewMode,
  args: Args,
  moved: Moved,
  hosted: boolean,
): number | null {
  if (!draftForTip(session)) session.writeDraft(serializePlanFile(moved.draft));
  if (draftState(session).kind === "valid") return null;
  session.writePrompt(renderPrompt(promptInput(session, mode, args, moved)));
  say(`wrote ${relative(cwd, session.promptPath)}`);
  const step = `assign the new units in ${relative(cwd, session.draftPath)}, then run follow-me again`;
  next(hosted ? `${step}; ${STILL_WORKING}` : step);
  return 0;
}

const STILL_WORKING = "the reviewer is still working";

/**
 * Applies the draft carried over to the moved tip under the server's lock (only freezes it for a
 * reviewer's walk) and moves the open page onto it, threads and all.
 */
async function swapOpenPage(session: Session, open: Open, args: Args): Promise<number> {
  const state = draftState(session);
  if (state.kind !== "valid") return 1;
  const syntax = await checkSyntax(state.prepared, syntaxOverride(args));
  if (syntax.issues.length > 0) {
    for (const line of formatSyntax(syntax)) say(line);
    next(`fix the draft, then run follow-me again; ${STILL_WORKING}`);
    return 1;
  }
  if (open.summary.mode === "split") {
    const code = await applyLocked(session, args);
    if (code !== 0) {
      next(`fix the draft, then run follow-me again; ${STILL_WORKING}`);
      return code;
    }
  } else session.freeze(state.prepared);
  const latest = session.plans().at(-1);
  if (latest === undefined) return 1;
  const swapped =
    latest.version === open.summary.version
      ? open.summary
      : await swapVersion(open.port, open.summary, latest.version, latest.hash);
  const carried = await fetchCarried(open.port, swapped);
  const changed = carried.filter((c) => c.changed);
  say(
    `swapped the open page to plan v${latest.version}; carried ${plural(carried.length, "comment")}, ${changed.length} changed`,
  );
  for (const { comment, path, newLine } of changed) {
    const where = path === null ? "no file" : newLine === null ? path : `${path}:${newLine}`;
    say(`  ${comment.id} now on ${where}`);
  }
  next(
    `${STILL_WORKING}; reply on each changed thread with follow-me reply <id> --body "<what changed and where>", then run follow-me again`,
  );
  return 0;
}

/** Writes the prompt for the agent and says where; used whenever there is no plan to review. */
function promptHandoff(session: Session, cwd: string, mode: ReviewMode, args: Args): number {
  session.writePrompt(renderPrompt(promptInput(session, mode, args)));
  const prompt = relative(cwd, session.promptPath);
  const draft = relative(cwd, session.draftPath);
  say(`wrote ${prompt}`);
  next(`write ${draft} from ${prompt}, then run follow-me again`);
  return 0;
}

/**
 * Where the last `follow-me` stopped reading this hosted session. seq is a position in one
 * server's log, so it only counts while the log is the same (id and openedAt); seen holds every
 * comment and reply id already read, which survives a restarted server that numbers its replay
 * afresh.
 */
type Cursor = {
  readonly session: string;
  readonly seq: number;
  readonly seen: ReadonlySet<string>;
};

function cursorPath(session: Session): string {
  return join(session.dir, "cursor.json");
}

function logOf(summary: HostedSummary): string {
  return `${summary.id}@${summary.openedAt}`;
}

function readCursor(session: Session, summary: HostedSummary): Cursor {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(cursorPath(session), "utf8"));
  } catch {
    raw = null;
  }
  const { session: log, seq, seen: ids } = isFields<"session" | "seq" | "seen">(raw) ? raw : {};
  const seen = new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : []);
  const counts =
    log === logOf(summary) && typeof seq === "number" && Number.isInteger(seq) && seq >= 0;
  return { session: logOf(summary), seq: counts ? seq : 0, seen };
}

function writeCursor(session: Session, cursor: Cursor): void {
  const { session: log, seq, seen } = cursor;
  writeFileSync(cursorPath(session), `${JSON.stringify({ session: log, seq, seen: [...seen] })}\n`);
}

/** The comment or reply id an event first carries, or null for events without one. */
function saidId(event: ServerEvent): string | null {
  if (event.type === "comment") return event.comment.id;
  return event.type === "reply" ? event.reply.id : null;
}

function waitOf(args: Args): number {
  const raw = args.values.get("wait");
  if (raw === undefined) return ENTRY_WAIT_SECONDS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new UsageError(`--wait ${raw} is not a number of seconds`);
  }
  return Math.min(seconds, MAX_ENTRY_WAIT_SECONDS);
}

/** One call fits inside a harness's tool timeout, so the agent's loop is one command per turn. */
const ENTRY_WAIT_SECONDS = 90;
const MAX_ENTRY_WAIT_SECONDS = 300;

/** The step that names the oldest accepted offer the agent has not answered, or null. */
async function offerStep(port: number, summary: HostedSummary): Promise<string | null> {
  const [first] = await fetchWaitingOffers(port, summary);
  if (first === undefined) return null;
  return `${STILL_WORKING}; offer ${first.offer} waits for your diagram: follow-me reply ${first.comment} --diagram <file> [--map <file>], then run follow-me again`;
}

/**
 * Listens to the hosted review for up to --wait seconds and prints what the reviewer did. It
 * returns at once with news, and with the report when the reviewer submitted or ended the review.
 */
async function listen(session: Session, open: Open, args: Args): Promise<number> {
  const { port, summary } = open;
  const waitMs = waitOf(args) * 1000;
  const deadline = Date.now() + waitMs;
  let cursor = readCursor(session, summary);
  let version = summary.version;
  for (;;) {
    const left = Math.max(0, deadline - Date.now());
    let batch: Awaited<ReturnType<typeof pollEvents>>;
    try {
      batch = await pollEvents(port, summary, cursor.seq, Math.min(left, POLL_MS));
    } catch (error) {
      if (!(error instanceof RegistrationError)) throw error;
      // The log restarted under us (a new server); read it from the start.
      cursor = { ...cursor, seq: 0 };
      writeCursor(session, cursor);
      continue;
    }
    const fresh = batch.events.filter((e) => {
      const id = saidId(e);
      return id === null || !cursor.seen.has(id);
    });
    const seen = new Set(cursor.seen);
    for (const event of batch.events) {
      const id = saidId(event);
      if (id !== null) seen.add(id);
    }
    cursor = { ...cursor, seq: batch.seq, seen };
    writeCursor(session, cursor);
    for (const event of batch.events) if (event.type === "version") version = event.version;
    const news = fresh.filter(isNews);
    if (news.length > 0) {
      const ctx = { commits: projectedCommits(session, version), units: session.diff.units };
      const ended = news.some((e) => e.type === "ended");
      const done = ended || news.some((e) => e.type === "submitted");
      // The report that follows quotes every comment, so the digest only says what else happened.
      const shown = done ? news.filter((e) => !isCommentEvent(e)) : news;
      process.stdout.write(renderEvents(shown, ctx));
      if (done) {
        say();
        if (ended) {
          const stored = reviewsOf(session).find((r) => r.version === version);
          if (stored !== undefined) return finished(session, stored);
        }
        process.stdout.write(await fetchReport(port, summary));
        say();
        next("done; the user can port it with follow-me report --json");
        return 0;
      }
      next(
        (await offerStep(port, summary)) ??
          `${STILL_WORKING}; answer with follow-me reply <id> --body "<markdown>" [--diagram file], then run follow-me again`,
      );
      return 0;
    }
    if (left <= 0) {
      next(
        (await offerStep(port, summary)) ??
          `${STILL_WORKING}; run follow-me again to keep listening`,
      );
      return 0;
    }
  }
}

/**
 * The agent's one command. Each call does the next thing that is missing and returns: it writes
 * the prompt, reports a bad draft, applies and opens the review, then listens to the reviewer
 * and hands back the report once the review is submitted.
 */
async function entry(cwd: string, args: Args): Promise<number> {
  syncSkills(homedir(), say);
  const session = await openFresh(cwd, args);
  const hosted = (await openOnServer(session, null)) ?? (await revive(session));
  const mode = hosted?.summary.mode ?? (await entryMode(session, args));
  const moved = await sinceLastPlan(session);
  if (moved !== null) {
    const handed = evolveHandoff(session, cwd, mode, args, moved, hosted !== null);
    if (handed !== null) return handed;
    if (hosted !== null) return swapOpenPage(session, hosted, args);
  }
  if (hosted !== null) return listen(session, hosted, args);

  const state = draftState(session);
  if (state.kind === "invalid") {
    next("fix the draft, then run follow-me again");
    return 1;
  }
  const done = reviewedPlan(session);
  if (state.kind === "valid") {
    const reviewed = reviewsOf(session).find(
      (r) => session.plans().find((p) => p.version === r.version)?.hash === state.prepared.hash,
    );
    if (reviewed !== undefined) return finished(session, reviewed);
  } else if (done !== null) {
    return finished(session, done);
  }

  let prepared: Prepared | null = null;
  if (state.kind === "valid") {
    const syntax = await checkSyntax(state.prepared, syntaxOverride(args));
    if (syntax.issues.length > 0) {
      for (const line of formatSyntax(syntax)) say(line);
      next("fix the draft, then run follow-me again");
      return 1;
    }
    if (mode === "split") {
      const code = await locked(session, "apply", () => applyLocked(session, args));
      if (code !== 0) {
        next("fix the draft, then run follow-me again");
        return code;
      }
      prepared = latestPlan(session);
    } else prepared = { version: session.freeze(state.prepared), plan: state.prepared };
  } else if (mode === "walk") {
    prepared = walkablePlan(session);
  }
  if (prepared === null) return promptHandoff(session, cwd, mode, args);

  const prep = prepared;
  const detached = { ...args, flags: new Set([...args.flags, "detach"]) };
  const result = await hostReview(session, mode, detached, async () => prep, reportSaved);
  if (result.kind !== "elsewhere") return exitCode(result);
  if (session.coverage() === null) {
    next(
      "if the project has tests, run them with coverage at the tip and pass the lcov to follow-me coverage",
    );
  }
  say("follow-me is interactive: keep running it until it prints the report");
  return listen(session, result, args);
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

/** The old name of review; it prints one line saying so and goes on. */
async function walk(cwd: string, args: Args): Promise<number> {
  console.error("follow-me: walk is now review; running review");
  return review(cwd, args);
}

async function walkPlan(session: Session, args: Args): Promise<Prepared | null> {
  const latest = walkablePlan(session);
  if (latest === null) {
    say(`no plan for ${session.anchor.branch} yet.`);
    say("Have a coding agent follow the prompt, then review again:");
    say(`  follow-me prompt --walk${branchFlag(args)}`);
    say(`  follow-me review${branchFlag(args)}`);
    return null;
  }
  return alreadyReviewed(session, latest.version, args) ? null : latest;
}

/** The consolidated report of a saved review, or null after saying why it cannot be rendered. */
async function renderStored(
  session: Session,
  stored: StoredReview,
  format: "markdown" | "json" = "markdown",
): Promise<string | null> {
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
  const { carried } = stored.review;
  const said = reviewsOf(session)
    .filter((r) => r.version <= stored.version)
    .map((r) => r.review);
  const earlier =
    carried === undefined
      ? {}
      : {
          earlier: {
            comments: sessionComments(carried, said),
            concerns: stored.review.carriedConcerns ?? [],
          },
        };
  const coverage = await coverageAt(session.root, session.dir, session.anchor.tip);
  const opts = {
    branch: session.anchor.branch,
    responses,
    ...earlier,
    ...(coverage === null ? {} : { coverage }),
  };
  if (format === "json") {
    const items = reportItems(stored.review, verdict.plan.commits, session.diff.units, opts);
    return `${JSON.stringify(items, null, 2)}\n`;
  }
  return renderReport(stored.review, verdict.plan.commits, session.diff.units, opts);
}

/**
 * The report of the hosted review as it stands, else of the latest one that ended. --json lists
 * the items to carry to a merge request; --markdown, the default, reads as the agent's to-do.
 * --walk keeps reading only reviewer-mode reviews, as `feedback --walk` did.
 */
async function report(cwd: string, args: Args, walkOnly = false): Promise<number> {
  if (args.flags.has("json") && args.flags.has("markdown")) {
    throw new UsageError("--json and --markdown cannot be used together");
  }
  const session = await openSession(cwd, sessionOpts(args));
  const format = args.flags.has("json") ? "json" : "markdown";
  const open = walkOnly ? null : await openOnServer(session, null);
  if (open !== null) {
    const text = await fetchReport(open.port, open.summary, format);
    process.stdout.write(
      format === "json" ? `${JSON.stringify(JSON.parse(text), null, 2)}\n` : text,
    );
    return 0;
  }
  const ended = (walkOnly ? session.walkReviews() : reviewsOf(session)).sort((a, b) =>
    a.review.endedAt.localeCompare(b.review.endedAt),
  );
  const stored = ended.at(-1);
  if (stored === undefined) {
    console.error("follow-me: no review is open and none has ended; run `follow-me review` first");
    return 1;
  }
  const text = await renderStored(session, stored, format);
  if (text === null) return 1;
  process.stdout.write(text);
  return 0;
}

const COVERAGE_USAGE = "usage: follow-me coverage <lcov> [--test <id> [--at <path:line>]]";

/**
 * Records the lcov of a test run the agent made at the tip in the session's coverage.json and
 * prints how much of the branch's changed code it ran. follow-me never runs the tests itself.
 */
async function coverage(cwd: string, args: Args): Promise<number> {
  const [file, extra] = args.positionals;
  const id = args.values.get("test");
  const atArg = args.values.get("at");
  if (file === undefined || extra !== undefined) throw new UsageError(COVERAGE_USAGE);
  if (atArg !== undefined && id === undefined) {
    throw new UsageError(`--at needs --test\n${COVERAGE_USAGE}`);
  }
  let text: string;
  try {
    text = readFileSync(resolve(cwd, file), "utf8");
  } catch {
    throw new UsageError(`cannot read ${file}`);
  }
  const records = parseLcov(text);
  const session = await openFresh(cwd, args);
  const { tip } = session.anchor;
  const place = tipPlacer(session.root, cwd, await pathsAt(session.root, tip));
  const run = runOf(records, place);
  if (run.files.size === 0) {
    throw new CoverageError(
      `none of the ${plural(new Set(records.map((r) => r.path)).size, "file")} in ${file} is in ${session.anchor.branch} at the tip; run follow-me coverage from the directory the tests ran in`,
    );
  }
  const changed = await pathsChanged(session.root, tip, null);
  const differ = [...run.files.keys()].filter((p) => changed.has(p));
  if (differ.length > 0) {
    throw new CoverageError(
      `coverage must be taken on the tip; these files differ: ${differ.map(show).join(", ")}`,
    );
  }
  let test: NamedTest | undefined;
  if (id !== undefined) {
    const at = atArg === undefined ? undefined : parseLocArg(atArg, place);
    if (typeof at === "string") throw new UsageError(at);
    test = { id, ...(at === undefined ? {} : { at }) };
  }
  const takenAt = new Date().toISOString();
  const recorded = recordRun(session.coverage(), run, {
    tip,
    takenAt,
    ...(test === undefined ? {} : { test }),
  });
  session.writeCoverage(recorded);
  const open = await openOnServer(session, null);
  if (open !== null) await postCoverage(open.port, open.summary);
  const { covered, executable } = totalOf(
    changedLines(session.diff.units, recorded.files).values(),
  );
  say(
    `coverage for ${plural(recorded.files.size, "file")} at ${short(tip)}; ${covered} of ${executable} changed lines covered`,
  );
  return 0;
}

/** The old name of report. */
async function feedback(cwd: string, args: Args): Promise<number> {
  console.error("follow-me: feedback is now report; printing the same");
  return report(cwd, args, args.flags.has("walk"));
}

function isCommentEvent(event: ServerEvent): boolean {
  return event.type === "comment" || event.type === "comment-updated";
}

/**
 * Events the reviewer caused; the agent's own replies, explanations, version swaps and coverage
 * are not news, and neither is a dismissed offer, which asks nothing of the agent.
 */
function isNews(event: ServerEvent): boolean {
  if (event.type === "version" || event.type === "coverage") return false;
  if (event.type === "offer-dismissed") return false;
  if (event.type === "comment" || event.type === "comment-updated") {
    return event.comment.author !== "agent";
  }
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
  const open = (await openOnServer(session, null)) ?? (await revive(session));
  if (open === null) return notOpen(session);
  const sinceRaw = args.values.get("since");
  let since = sinceRaw === undefined ? 0 : Number(sinceRaw);
  if (!Number.isInteger(since) || since < 0) {
    throw new UsageError(`--since ${sinceRaw} is not an event number`);
  }
  // Comments are quoted as the plan they were made on wrote them; a swap changes which that is.
  let version = open.summary.version;
  const quoting = (events: readonly ServerEvent[]) => {
    for (const event of events) if (event.type === "version") version = event.version;
    return { commits: projectedCommits(session, version), units: session.diff.units };
  };
  if (args.flags.has("follow")) {
    let ended = false;
    await followEvents(open.port, open.summary, since, (event) => {
      if (event.type === "ended") ended = true;
      const ctx = quoting([event]);
      if (!isNews(event)) return;
      if (args.flags.has("json")) say(JSON.stringify(event));
      else process.stdout.write(renderEvents([event], ctx));
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
    const ctx = quoting(batch.events);
    const news = batch.events.filter(isNews);
    if (news.length === 0) continue;
    if (args.flags.has("json")) for (const event of news) say(JSON.stringify(event));
    else {
      process.stdout.write(renderEvents(news, ctx));
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
  const diagram = diagramOf(args);
  // A diagram can be the whole answer, as when it answers an accepted offer.
  const body = args.values.get("body") ?? (diagram === undefined ? undefined : "");
  if (commentId === undefined || extra !== undefined || body === undefined) {
    throw new UsageError(
      "usage: follow-me reply <commentId> --body <text> [--diagram <file>]\n       follow-me reply <commentId> --diagram <file> [--body <text>]",
    );
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
  next(`run follow-me again; ${STILL_WORKING}`);
  return 0;
}

/** The Mermaid source in --diagram's file, or undefined without the flag. */
function diagramOf(args: Args): string | undefined {
  const file = args.values.get("diagram");
  if (file === undefined) return undefined;
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    throw new UsageError(`cannot read ${file}: ${error instanceof Error ? error.message : error}`);
  }
}

/** "3" or "2-5" as the change indices they name. */
function parseLineRange(raw: string): number[] {
  const m = /^(\d+)(?:-(\d+))?$/.exec(raw);
  const from = Number(m?.[1]);
  const to = Number(m?.[2] ?? m?.[1]);
  if (m === null || to < from) {
    throw new UsageError(`--lines ${raw} is not a change line or a range like 2-5`);
  }
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/**
 * Where an explanation points: --unit with --lines names change lines of a hunk, as the prompt
 * numbers them, and the page marks their rows. --commit alone is the commit itself; nothing is
 * the whole plan. Commits count from 1, as the prompt prints them.
 */
function explainTarget(
  session: Session,
  version: PlanVersion,
  args: Args,
): Pick<Comment, "anchor" | "context"> {
  const commitRaw = args.values.get("commit");
  const unitRaw = args.values.get("unit");
  const linesRaw = args.values.get("lines");
  if (linesRaw !== undefined && unitRaw === undefined) {
    throw new UsageError("--lines needs --unit");
  }
  if (commitRaw === undefined && unitRaw === undefined) {
    return { anchor: { kind: "plan" }, context: { commitMessage: "", path: null } };
  }
  const commits = projectedCommits(session, version);
  if (commits.length === 0) {
    throw new UsageError(`plan v${version} no longer fits ${session.anchor.branch}`);
  }
  const unit =
    unitRaw === undefined || !isUnitId(unitRaw) ? undefined : session.diff.units.get(unitRaw);
  if (unitRaw !== undefined && unit === undefined) {
    throw new UsageError(`--unit ${unitRaw} is not a unit of this branch`);
  }
  let index = -1;
  if (commitRaw !== undefined) {
    index = Number(commitRaw) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= commits.length) {
      throw new UsageError(`--commit ${commitRaw} is not one of the ${commits.length} commits`);
    }
  } else {
    index = commits.findIndex((c) => c.refs.some((r) => r.unit === unit?.id));
  }
  const commit = commits[index];
  if (commit === undefined) throw new UsageError(`no commit of plan v${version} takes ${unitRaw}`);
  if (unit === undefined) {
    return {
      anchor: { kind: "message", commit: index },
      context: { commitMessage: commit.message, path: null },
    };
  }
  const ref = commit.refs.find((r) => r.unit === unit.id);
  if (ref === undefined) throw new UsageError(`commit ${index + 1} does not take ${unit.id}`);
  const context = { commitMessage: commit.message, path: unit.path };
  if (linesRaw === undefined) {
    return { anchor: { kind: "hunk", unit: unit.id, commit: index, changes: null }, context };
  }
  if (unit.kind !== "hunk")
    throw new UsageError(`--lines needs a text hunk, ${unit.id} is not one`);
  const changes = parseLineRange(linesRaw);
  const taken = ref.select.kind === "lines" ? ref.select.changes : null;
  for (const n of changes) {
    if (n >= unit.changeCount || (taken !== null && !taken.includes(n))) {
      throw new UsageError(`commit ${index + 1} does not take change line ${n} of ${unit.id}`);
    }
  }
  const rows = unit.body.flatMap((line, offset) =>
    line.op !== " " && changes.includes(line.change) ? [{ line, offset }] : [],
  );
  return {
    anchor: {
      kind: "hunk",
      unit: unit.id,
      commit: index,
      changes,
      offsets: rows.map((r) => r.offset),
    },
    context: {
      ...context,
      lines: rows.map(({ line }) => `${line.op}${line.text.replace(/\r?\n$/, "")}`),
    },
  };
}

/** Starts a thread on the hosted page: the agent explains before anyone asks. */
async function explain(cwd: string, args: Args): Promise<number> {
  const body = args.values.get("body");
  if (body === undefined || args.positionals.length > 0) {
    throw new UsageError(
      "usage: follow-me explain [--commit <n>] [--unit <id>] [--lines <a-b>] --body <text> [--diagram <file>]",
    );
  }
  const diagram = diagramOf(args);
  const session = await openSession(cwd, sessionOpts(args));
  const open = await openOnServer(session, null);
  if (open === null) return notOpen(session);
  const target = explainTarget(session, open.summary.version, args);
  const id = await postComment(open.port, open.summary, {
    ...target,
    body,
    author: "agent",
    ...(diagram === undefined ? {} : { diagram }),
  });
  say(`explained ${id}`);
  next(`run follow-me again; ${STILL_WORKING}`);
  return 0;
}

const SHOW_USAGE = "usage: follow-me show <h_…|c_…|k_…|path:line[@<commit>|@base]|name>";

/** Every comment the session has, with the plan version it was made on: live ones first. */
async function knownComments(
  session: Session,
): Promise<{ version: PlanVersion; comments: readonly Comment[] }[]> {
  const open = await openOnServer(session, null);
  const live = open === null ? [] : await fetchComments(open.port, open.summary);
  const saved = [
    session.priorReview("split", null),
    session.priorReview("walk", null),
    ...reviewsOf(session).map((r) => r.review),
  ].flatMap((r) => (r === null ? [] : [{ version: r.planVersion, comments: r.comments }]));
  return [...live, ...saved];
}

const SHOW_MARGIN = 3;

/**
 * The lines around path:line as commit `at` of the latest plan writes the file (1-based), the
 * base, or the tip when `at` is undefined. Read from the plan, so it works before any apply.
 */
function showLines(session: Session, raw: string): string {
  const m = /^(.+):(\d+)(?:@(\d+|base))?$/.exec(raw);
  const [, typed, lineRaw, at] = m ?? [];
  if (typed === undefined || lineRaw === undefined) throw new UsageError(SHOW_USAGE);
  const path = Buffer.from(typed, "utf8").toString("latin1");
  const file = [...session.diff.textFiles.values()].find((f) => f.path === path);
  if (file === undefined) {
    return `${typed} is not a text file this branch changes; it reads the same in every commit, so read it from the working tree\n`;
  }
  let text: string | null;
  let label: string;
  if (at === undefined) {
    text = file.tip?.bytes ?? null;
    label = "the tip";
  } else if (at === "base") {
    text = file.base === null ? null : file.base.lines.join("");
    label = "the base";
  } else {
    const latest = session.plans().at(-1);
    const commits = latest === undefined ? [] : projectedCommits(session, latest.version);
    const n = Number(at);
    if (n < 1 || n > commits.length) {
      throw new UsageError(`@${at} is not one of the ${commits.length} commits of the plan`);
    }
    text = file.base === null ? null : file.base.lines.join("");
    for (const commit of commits.slice(0, n)) {
      for (const change of commit.changes) {
        if (change.path !== path) continue;
        text = change.op === "write" ? change.bytes : null;
      }
    }
    label = `commit ${n}`;
  }
  if (text === null) return `${typed} does not exist in ${label}\n`;
  const lines = Buffer.from(text, "latin1").toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const line = Number(lineRaw);
  if (line < 1 || line > lines.length) {
    return `${typed} has ${plural(lines.length, "line")} in ${label}\n`;
  }
  const from = Math.max(1, line - SHOW_MARGIN);
  const to = Math.min(lines.length, line + SHOW_MARGIN);
  const width = String(to).length;
  const rows = lines.slice(from - 1, to).map((l, i) => {
    const n = from + i;
    return `${n === line ? ">" : " "} ${String(n).padStart(width)}  ${l}`;
  });
  return `${typed}:${line} in ${label}\n${rows.join("\n")}\n`;
}

/** Expands a ref the agent was given to the lines and thread it names, so no file read is needed. */
async function showRef(cwd: string, args: Args): Promise<number> {
  const [ref, extra] = args.positionals;
  if (ref === undefined || extra !== undefined) throw new UsageError(SHOW_USAGE);
  const session = await openSession(cwd, sessionOpts(args));
  const { units } = session.diff;
  const latest = session.plans().at(-1);
  if (isUnitId(ref)) {
    const unit = units.get(ref);
    if (unit === undefined) {
      throw new UsageError(`${ref} is not a unit of the branch now; its hunk changed`);
    }
    const commits = latest === undefined ? [] : projectedCommits(session, latest.version);
    process.stdout.write(renderShownUnit(unit, commits));
    return 0;
  }
  if (/^c_[a-z2-7]{6}$/.test(ref) && isCommentId(ref)) {
    for (const { version, comments } of await knownComments(session)) {
      const comment = comments.find((c) => c.id === ref);
      if (comment === undefined) continue;
      const ctx = { commits: projectedCommits(session, version), units };
      process.stdout.write(renderShownComment(comment, ctx, version));
      return 0;
    }
    throw new UsageError(`no comment ${ref} in this session`);
  }
  if (isConcernId(ref)) {
    for (const plan of session.plans().toReversed()) {
      const commits = projectedCommits(session, plan.version);
      for (const commit of commits) {
        const concern = commit.concerns?.find((k) => k.id === ref);
        if (concern === undefined) continue;
        process.stdout.write(renderShownConcern(concern, commit.index, { commits, units }));
        return 0;
      }
    }
    throw new UsageError(`no concern ${ref} in a plan that fits the branch`);
  }
  if (isIdentifier(ref)) {
    const commits = latest === undefined ? [] : projectedCommits(session, latest.version);
    const index = definitionIndex(session.root, session.diff.tip, units, commits);
    process.stdout.write(renderShownDefinitions(ref, await index.lookup(ref, null)));
    return 0;
  }
  process.stdout.write(showLines(session, ref));
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
  return `no draft at ${relative(cwd, error.path)} yet; your coding agent writes it from \`follow-me prompt\`, or \`follow-me plan --naive\` writes one commit per file`;
}

const PACKAGE_NAME = "@shiyuphan/follow-me";

/**
 * Updates the global package, then refreshes every installed skill copy, which otherwise
 * stays at the old version. FOLLOW_ME_UPGRADE_COMMAND replaces the npm call in tests.
 */
function upgrade(targets: SkillTargets, cwd: string): number {
  const override = process.env["FOLLOW_ME_UPGRADE_COMMAND"];
  const command =
    override === undefined
      ? ["npm", "install", "-g", `${PACKAGE_NAME}@latest`]
      : ["sh", "-c", override];
  const [file, ...args] = command;
  if (file === undefined) return 1;
  say(`${targets.dryRun ? "would run" : "running"}: ${override ?? command.join(" ")}`);
  if (!targets.dryRun) {
    try {
      execFileSync(file, args, { stdio: "inherit" });
    } catch (error) {
      console.error(`follow-me: upgrade failed: ${error instanceof Error ? error.message : error}`);
      return 1;
    }
  }
  const code = runInstall({ ...targets, list: false }, homedir(), cwd, say);
  if (code === 0) say(`next: follow-me --version`);
  return code;
}

const HELP_OR_VERSION = new Set(["--help", "--version"]);

/**
 * The port the page was last served on for this session. A server that died or exited idle
 * takes its record with it; reusing the port keeps an open page on a live origin.
 */
function rememberedPort(session: Session): number | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(session.dir, "page.json"), "utf8"));
    if (typeof raw === "object" && raw !== null && "port" in raw) {
      const port = raw.port;
      if (typeof port === "number" && Number.isInteger(port) && port > 0) return port;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function rememberPort(session: Session, port: number): void {
  writeFileSync(join(session.dir, "page.json"), `${JSON.stringify({ port })}\n`);
}

export async function main(argv: readonly string[], cwd: string): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === undefined || (command.startsWith("--") && !HELP_OR_VERSION.has(command))) {
      const spec = {
        values: ["wait", "base", "branch", "port", "syntax", "name"],
        flags: ["no-open", "author", "reviewer", "allow-syntax-errors", "force", "sign", "no-sign"],
      };
      return await entry(cwd, parseArgs(argv, spec));
    }
    switch (command) {
      case "extract": {
        const args = parseArgs(rest, { values: ["base", "branch"] });
        summarize(await extractSession(cwd, sessionOpts(args)), cwd);
        const branch = branchFlag(args);
        next(`follow-me prompt${branch}, or follow-me plan --naive${branch}`);
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
        return await plan(cwd, parseArgs(rest, { values: ["branch"], flags: ["walk", "naive"] }));
      case "split": {
        const spec = {
          values: ["base", "branch", "syntax"],
          flags: ["no-open", "allow-syntax-errors"],
        };
        return await split(cwd, parseArgs(rest, spec));
      }
      case "review": {
        const spec = {
          values: ["base", "branch", "port", "timeout"],
          flags: ["no-open", "detach", "wait"],
        };
        return await review(cwd, parseArgs(rest, spec));
      }
      case "walk": {
        const spec = { values: ["base", "branch", "port"], flags: ["no-open", "detach"] };
        return await walk(cwd, parseArgs(rest, spec));
      }
      case "server":
        return await serverCommand(rest);
      case "feedback":
        return await feedback(
          cwd,
          parseArgs(rest, { values: ["branch"], flags: ["walk", "json", "markdown"] }),
        );
      case "watch": {
        const spec = { values: ["since", "timeout", "branch"], flags: ["json", "follow"] };
        return await watch(cwd, parseArgs(rest, spec));
      }
      case "reply":
        return await reply(cwd, parseArgs(rest, { values: ["body", "diagram", "branch"] }));
      case "explain": {
        const spec = { values: ["commit", "unit", "lines", "body", "diagram", "branch"] };
        return await explain(cwd, parseArgs(rest, spec));
      }
      case "show":
        return await showRef(cwd, parseArgs(rest, { values: ["branch"] }));
      case "coverage":
        return await coverage(cwd, parseArgs(rest, { values: ["test", "at", "branch"] }));
      case "report":
        return await report(
          cwd,
          parseArgs(rest, { values: ["branch"], flags: ["json", "markdown"] }),
        );
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
      case "upgrade": {
        const args = parseArgs(rest, { values: ["harness"], flags: ["all", "project", "dry-run"] });
        return upgrade(skillTargets(args), cwd);
      }
      case "help":
      case "-h":
      case "--help":
        say(parseArgs(rest, { flags: ["all"] }).flags.has("all") ? USAGE : SHORT_USAGE);
        return 0;
      case "-v":
      case "--version":
        say(`follow-me ${version()}`);
        return 0;
      default:
        throw new UsageError(`unknown command "${command}"\n${SHORT_USAGE}`);
    }
  } catch (error) {
    const known = [
      UsageError,
      CoverageError,
      LcovError,
      BranchMovedError,
      BranchRefusedError,
      SessionFileError,
      SessionLockedError,
      RegistrationError,
      GitError,
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
