// A stand-in for the follow-me server at the network boundary: fetch answers per route and an
// EventSource the test pushes events into. Components, state and events run for real.

import type { ServerEvent, State } from "../lib/wire.ts";

export type Call = { readonly method: string; readonly path: string; readonly body: unknown };
type Handler = (call: Call) => unknown;

export type FakeServer = {
  readonly calls: Call[];
  /** Answers a route; return undefined from a handler for an empty 200. */
  on(method: string, path: string | RegExp, handler: Handler): void;
  /** Delivers one event to every open stream, as the server would after a write. */
  push(event: Omit<ServerEvent, "seq">): void;
  restore(): void;
};

class FakeEventSource extends EventTarget {
  static readonly CLOSED = 2;
  static open = new Set<FakeEventSource>();
  readyState = 1;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeEventSource.open.add(this);
  }
  close() {
    this.readyState = 2;
    FakeEventSource.open.delete(this);
  }
}

export function fakeServer(state: State): FakeServer {
  const calls: Call[] = [];
  const routes: { method: string; path: string | RegExp; handler: Handler }[] = [];
  let seq = state.seq;
  const realFetch = globalThis.fetch;
  const realEventSource = globalThis.EventSource;
  const server: FakeServer = {
    calls,
    on: (method, path, handler) => routes.unshift({ method, path, handler }),
    push: (event) => {
      seq += 1;
      const data = JSON.stringify({ ...event, seq });
      for (const source of FakeEventSource.open) {
        source.onmessage?.(new MessageEvent("message", { data }));
      }
    },
    restore: () => {
      globalThis.fetch = realFetch;
      Object.defineProperty(globalThis, "EventSource", {
        value: realEventSource,
        configurable: true,
        writable: true,
      });
      for (const source of [...FakeEventSource.open]) source.close();
    },
  };
  server.on("GET", "/api/state", () => state);
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), location.href);
    const path = `${url.pathname.replace(/^\/s\/[^/]+/, "")}${url.search}`;
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call = { method, path, body };
    calls.push(call);
    const route = routes.find(
      (r) =>
        r.method === method && (typeof r.path === "string" ? r.path === path : r.path.test(path)),
    );
    if (route === undefined)
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    return new Response(JSON.stringify(route.handler(call) ?? {}), { status: 200 });
  };
  // The fake implements only what the page uses, so it replaces the global without a type claim.
  Object.defineProperty(globalThis, "EventSource", {
    value: FakeEventSource,
    configurable: true,
    writable: true,
  });
  return server;
}
