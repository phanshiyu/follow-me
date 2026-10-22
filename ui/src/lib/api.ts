import type { Coverage } from "./coverage.ts";
import type { Candidate, NewComment, ReportItem, Severity, State } from "./wire.ts";

/** "/s/<id>": every session API sits under it, and the page is served at its root. */
export const sessionPrefix = /^\/s\/[^/]+/.exec(location.pathname)?.[0] ?? "";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const RETRY_MS = 400;

/**
 * The server is this package's own, so its JSON is trusted to match the wire types. A write during
 * a plan swap answers 409 and is safe to repeat once a moment later.
 */
async function call<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  const res = await fetch(`${sessionPrefix}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.status === 409 && method !== "GET" && !retried) {
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    return call(method, path, body, true);
  }
  const text = await res.text();
  if (!res.ok)
    throw new ApiError(res.status, errorOf(text) ?? `${method} ${path} failed with ${res.status}`);
  // JSON.parse is untyped; the payload is the server's own wire shape for this route.
  return JSON.parse(text === "" ? "{}" : text);
}

function errorOf(text: string): string | null {
  try {
    const body: unknown = JSON.parse(text);
    return typeof body === "object" && body !== null && "error" in body ? String(body.error) : null;
  } catch {
    return null;
  }
}

export const api = {
  state: () => call<State>("GET", "/api/state"),
  /**
   * Posts a comment. A question starts out of the hand-off, because most are asked to understand
   * the code; the reviewer can include it there.
   */
  comment: async (comment: NewComment) => {
    const posted = await call<{ id: string }>("POST", "/api/comments", comment);
    if (comment.kind === "question") {
      await call("POST", "/api/excluded", { comment: posted.id, excluded: true }).catch(
        () => undefined,
      );
    }
    return posted;
  },
  reply: (id: string, body: string) =>
    call<{ id: string }>("POST", `/api/comments/${id}/replies`, { author: "reviewer", body }),
  decide: (id: string, decision: "kept" | "dismissed", severity?: Severity) =>
    call<unknown>("POST", `/api/concerns/${id}`, {
      decision,
      ...(severity === undefined ? {} : { severity }),
    }),
  resolve: (id: string, resolved: boolean) =>
    call<unknown>("POST", "/api/resolved", { comment: id, resolved }),
  submit: (summary: string) =>
    call<unknown>("POST", "/api/submit", summary.trim() === "" ? {} : { summary }),
  exclude: (id: string, excluded: boolean) =>
    call<unknown>("POST", "/api/excluded", {
      [id.startsWith("k_") ? "concern" : "comment"]: id,
      excluded,
    }),
  /** Waves an offer away; it stays dismissed across plan versions. */
  dismissOffer: (id: string) =>
    call<unknown>("POST", `/api/offers/${encodeURIComponent(id)}/dismiss`),
  report: () => call<readonly ReportItem[]>("GET", "/api/report?format=json"),
  end: () => call<{ saved: string }>("POST", "/api/end"),
  /** The last test run handed over for this branch, or null when there is none. */
  coverage: () =>
    call<Coverage>("GET", "/api/coverage").catch((failure: unknown) => {
      if (failure instanceof ApiError && failure.status === 404) return null;
      throw failure;
    }),
  /** Where a name is defined, ranked for the file it is used in. */
  definition: (name: string, from: string) =>
    call<{ readonly candidates: readonly Candidate[] }>(
      "GET",
      `/api/definition?${new URLSearchParams({ name, from })}`,
    ),
};
