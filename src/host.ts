import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type NewReply, parseEvent, parseEventBatch } from "./comments.ts";
import { isPlanVersion, serializePlanFile, validatePlan } from "./plan.ts";
import {
  HEALTH_APP,
  type Host,
  isSessionId,
  type Loaded,
  loadDraftComments,
  PortInUseError,
  type Registration,
  RegistrationError,
  startServer,
} from "./server.ts";
import {
  BranchMovedError,
  isAlive,
  openSessionAt,
  SessionFileError,
  SessionLockedError,
} from "./session.ts";
import type { Comment, HostedSummary, PlanVersion, ServerEvent, ServerRecord } from "./types.ts";

const RECORD = "server.json";
const DEFAULT_IDLE_MS = 30_000;
const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 5_000;

type Env = Readonly<Record<string, string | undefined>>;

/** `FOLLOW_ME_HOME`, else `$XDG_STATE_HOME/follow-me`, else `~/.local/state/follow-me`. */
export function stateDir(env: Env = process.env, home: string = homedir()): string {
  const own = env["FOLLOW_ME_HOME"];
  if (own) return own;
  const xdg = env["XDG_STATE_HOME"];
  return join(xdg ? xdg : join(home, ".local", "state"), "follow-me");
}

/** How long a server waits for a new session after its last one ended. */
export function idleMs(env: Env = process.env): number {
  const raw = Number(env["FOLLOW_ME_IDLE_MS"]);
  return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_IDLE_MS;
}

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535;
}

function isFields(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The record as written; a missing or unreadable one reads as no server. */
export function readServerRecord(dir: string): ServerRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, RECORD), "utf8"));
  } catch {
    return null;
  }
  if (!isFields(raw)) return null;
  const { pid, port, startedAt } = raw;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (!isPort(port) || typeof startedAt !== "string") return null;
  return { pid, port, startedAt };
}

/** The pid of the follow-me server answering on this port, or null for anything else. */
export async function probeHealth(port: number): Promise<number | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    const body: unknown = await res.json();
    if (!isFields(body) || body["app"] !== HEALTH_APP) return null;
    const pid = body["pid"];
    return typeof pid === "number" && Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** The user's server if its record names a live process that answers as ours. */
export async function findServer(dir: string): Promise<ServerRecord | null> {
  const record = readServerRecord(dir);
  if (record === null || !isAlive(record.pid)) return null;
  return (await probeHealth(record.port)) === record.pid ? record : null;
}

/**
 * Writes server.json unless a live server already owns it, and returns the record that holds.
 * Linking a complete temp file fails when the record exists, so two servers starting at once
 * cannot both claim it; a record left by a dead server is replaced.
 */
async function claimRecord(dir: string, mine: ServerRecord): Promise<ServerRecord> {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, RECORD);
  for (let attempt = 0; attempt < 3; attempt++) {
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(mine, null, 2)}\n`);
    try {
      linkSync(temp, path);
      return mine;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    } finally {
      rmSync(temp, { force: true });
    }
    const live = await findServer(dir);
    if (live !== null) return live;
    rmSync(path, { force: true });
  }
  throw new Error(`could not claim ${path}`);
}

function removeRecord(dir: string, pid: number): void {
  if (readServerRecord(dir)?.pid === pid) rmSync(join(dir, RECORD), { force: true });
}

async function loadHosted(
  registration: Registration,
  held: Loaded["release"] | null,
): Promise<Loaded> {
  const { dir, mode, version, hash, lockToken } = registration;
  try {
    const session = await openSessionAt(dir);
    const branch = session.anchor.branch;
    const stored = session.plans().find((p) => p.version === version);
    if (stored === undefined || stored.hash !== hash) {
      throw new RegistrationError(`${branch} has no plan v${version} with hash ${hash}`);
    }
    // Each mode has its own slot, so a walk can follow the author's review of the same plan.
    const reviewed = mode === "walk" ? session.walkReviews() : session.reviews();
    if (reviewed.some((r) => r.version === version)) {
      const what = mode === "walk" ? "code review" : "review";
      throw new RegistrationError(`plan v${version} of ${branch} already has a ${what}`);
    }
    const verdict = validatePlan(session.diff, serializePlanFile(stored.file), {
      lastReview: session.lastReview(),
    });
    if (!verdict.ok) {
      throw new RegistrationError(`plan v${version} no longer fits ${branch}; check it again`);
    }
    const reviewsDir = session.reviewsDir();
    const comments = await loadDraftComments(reviewsDir, version);
    const prior = session.priorReview(mode, version);
    const previous =
      prior === null || prior.comments.length === 0
        ? null
        : {
            version: prior.planVersion,
            comments: prior.comments,
            responses: stored.file.responses,
          };
    const command = "review";
    // A version swap runs inside the server that already owns this session's lock.
    const release =
      held ??
      (lockToken === null ? session.lock(command) : session.adoptLock(lockToken, command)).release;
    return {
      repo: session.root,
      reviewsDir,
      release,
      previous,
      state: {
        mode,
        anchor: session.anchor,
        version,
        planHash: verdict.plan.hash,
        commits: verdict.plan.commits,
        units: [...session.diff.units.values()],
        comments,
      },
    };
  } catch (error) {
    const refusal =
      error instanceof SessionLockedError ||
      error instanceof BranchMovedError ||
      error instanceof SessionFileError;
    if (refusal) throw new RegistrationError(error.message);
    throw error;
  }
}

export type Started =
  | { readonly kind: "started"; readonly host: Host }
  | { readonly kind: "attached"; readonly port: number };

export function portFallbackMessage(requested: number, used: number): string {
  return `port ${requested} is in use by another program, using ${used}`;
}

/**
 * Starts this process as the user's server, or finds that one is already up. A requested port
 * held by our own server means attach; held by anything else, the server takes a free port.
 */
export async function startOrAttach(
  dir: string,
  port: number | undefined,
  say: (line: string) => void,
): Promise<Started> {
  const requested = port ?? 0;
  const options = { idleMs: idleMs(), load: loadHosted };
  let host: Host;
  try {
    host = await startServer({ ...options, port: requested });
  } catch (error) {
    if (!(error instanceof PortInUseError)) throw error;
    if ((await probeHealth(requested)) !== null) return { kind: "attached", port: requested };
    host = await startServer({ ...options, port: 0 });
    say(portFallbackMessage(requested, host.port));
  }
  const mine = { pid: process.pid, port: host.port, startedAt: new Date().toISOString() };
  const owner = await claimRecord(dir, mine);
  if (owner.pid !== process.pid) {
    await host.close();
    return { kind: "attached", port: owner.port };
  }
  const stop = () => void host.close();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  void host.closed.then(() => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    removeRecord(dir, process.pid);
  });
  return { kind: "started", host };
}

/**
 * Starts the server as a detached `follow-me server run` and waits until it answers. Its output
 * goes to server.log in the state dir.
 */
export async function spawnDetached(dir: string, port: number | undefined): Promise<ServerRecord> {
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, "server.log");
  const log = openSync(logPath, "a");
  const script = process.argv[1];
  if (script === undefined) throw new Error("cannot tell which script runs follow-me");
  const args = [...process.execArgv, script, "server", "run"];
  if (port !== undefined) args.push("--port", String(port));
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  closeSync(log);
  child.unref();
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const live = await findServer(dir);
    if (live !== null) return live;
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`the review server did not start; see ${logPath}`);
}

async function call(port: number, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload: unknown = await res.json();
  if (!res.ok) {
    const reason = isFields(payload) ? payload["error"] : undefined;
    throw new RegistrationError(
      typeof reason === "string" ? reason : `${method} ${path} failed with ${res.status}`,
    );
  }
  return payload;
}

function parseSummary(raw: unknown): HostedSummary | null {
  if (!isFields(raw)) return null;
  const { id, url, repo, branch, mode, version, comments, openedAt } = raw;
  if (typeof url !== "string" || typeof repo !== "string") return null;
  if (typeof branch !== "string" || (mode !== "split" && mode !== "walk")) return null;
  if (!isSessionId(id) || !isPlanVersion(version) || typeof comments !== "number") return null;
  if (typeof openedAt !== "string") return null;
  return { id, url, repo, branch, mode, version, comments, openedAt };
}

/** Registers a session with the server on this port; the same session yields the same URL. */
export async function registerWith(
  port: number,
  registration: Registration,
): Promise<HostedSummary> {
  const summary = parseSummary(await call(port, "POST", "/api/sessions", registration));
  if (summary === null) throw new RegistrationError("the server answered with a malformed session");
  return summary;
}

/** Moves the hosted session to a newer frozen plan; its id and URL stay. */
export async function swapVersion(
  port: number,
  summary: HostedSummary,
  version: PlanVersion,
  hash: string,
): Promise<HostedSummary> {
  const swapped = parseSummary(
    await call(port, "POST", `${summary.url}api/version`, { version, hash }),
  );
  if (swapped === null) throw new RegistrationError("the server answered with a malformed session");
  return swapped;
}

/** One long poll of the session's event log: what happened after `since`, or nothing at timeout. */
export async function pollEvents(
  port: number,
  summary: HostedSummary,
  since: number,
  timeoutMs: number,
) {
  const path = `${summary.url}api/events?since=${since}&timeout=${timeoutMs}`;
  const batch = parseEventBatch(await call(port, "GET", path));
  if (typeof batch === "string")
    throw new RegistrationError(`the server sent bad events: ${batch}`);
  return batch;
}

/**
 * Follows the session's event stream from `since`, calling `onEvent` for each event. Resolves when
 * the server closes the stream, which it does after the `ended` event.
 */
export async function followEvents(
  port: number,
  summary: HostedSummary,
  since: number,
  onEvent: (event: ServerEvent) => void,
): Promise<void> {
  const res = await fetch(`${sessionUrl(port, summary)}api/events/stream?since=${since}`);
  if (!res.ok || res.body === null) {
    throw new RegistrationError(`GET api/events/stream failed with ${res.status}`);
  }
  const decoder = new TextDecoder();
  const gap = "\n\n";
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let end = buffer.indexOf(gap); end !== -1; end = buffer.indexOf(gap)) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = frame.split("\n").find((l) => l.startsWith("data: "));
      if (data === undefined) continue;
      const event = parseEvent(JSON.parse(data.slice(6)));
      if (typeof event === "string")
        throw new RegistrationError(`bad event on the stream: ${event}`);
      onEvent(event);
    }
  }
}

/** Posts the agent's reply under a comment and returns the new reply's id. */
export async function postReply(
  port: number,
  summary: HostedSummary,
  commentId: string,
  reply: NewReply,
): Promise<string> {
  const path = `${summary.url}api/comments/${encodeURIComponent(commentId)}/replies`;
  const body = await call(port, "POST", path, reply);
  const id = isFields(body) ? body["id"] : undefined;
  if (typeof id !== "string") throw new RegistrationError("the server answered without a reply id");
  return id;
}

/** Posts a comment the agent starts and returns its id; the server mints id and time. */
export async function postComment(
  port: number,
  summary: HostedSummary,
  comment: Omit<Comment, "id" | "createdAt">,
): Promise<string> {
  const body = await call(port, "POST", `${summary.url}api/comments`, comment);
  const id = isFields(body) ? body["id"] : undefined;
  if (typeof id !== "string") {
    throw new RegistrationError("the server answered without a comment id");
  }
  return id;
}

/** The consolidated report of the hosted session as it stands. */
export async function fetchReport(
  port: number,
  summary: HostedSummary,
  format: "markdown" | "json" = "markdown",
): Promise<string> {
  const res = await fetch(`${sessionUrl(port, summary)}api/report?format=${format}`);
  if (!res.ok) throw new RegistrationError(`GET api/report failed with ${res.status}`);
  return res.text();
}

export async function listSessions(port: number): Promise<readonly HostedSummary[]> {
  const raw = await call(port, "GET", "/api/sessions");
  if (!Array.isArray(raw)) throw new RegistrationError("the server listed malformed sessions");
  return raw.flatMap((item: unknown) => {
    const summary = parseSummary(item);
    return summary === null ? [] : [summary];
  });
}

export function sessionUrl(port: number, summary: HostedSummary): string {
  return `http://127.0.0.1:${port}${summary.url}`;
}

/** Whether the server on this port still serves the session's state; a gone server serves none. */
export async function stillHosted(port: number, summary: HostedSummary): Promise<boolean> {
  try {
    const res = await fetch(`${sessionUrl(port, summary)}api/state`, {
      signal: AbortSignal.timeout(2_000),
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Stops the recorded server and waits for it to exit. Only a pid that answers as our server on
 * the recorded port is signalled, so a reused pid is never killed. A stale record is removed.
 */
export async function stopServer(dir: string): Promise<ServerRecord | null> {
  const live = await findServer(dir);
  if (live === null) {
    const record = readServerRecord(dir);
    if (record !== null) removeRecord(dir, record.pid);
    return null;
  }
  process.kill(live.pid, "SIGTERM");
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (isAlive(live.pid)) {
    if (Date.now() > deadline) throw new Error(`server pid ${live.pid} did not stop`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  removeRecord(dir, live.pid);
  return live;
}

export function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [url], { stdio: "ignore", detached: true });
  child.on("error", (error) => console.error(`could not open a browser: ${error.message}`));
  child.unref();
}
