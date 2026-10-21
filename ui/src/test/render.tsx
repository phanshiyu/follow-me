import { afterEach } from "vitest";
import { render } from "vitest-browser-react";
import "../index.css";
import { Handoff } from "../components/Handoff.tsx";
import { ReviewPage } from "../components/ReviewPage.tsx";
import type { State } from "../lib/wire.ts";
import { ReviewProvider } from "../store.tsx";
import { type FakeServer, fakeServer } from "./server.ts";

let current: FakeServer | null = null;
afterEach(() => {
  current?.restore();
  current = null;
  localStorage.clear();
});

/** The review page over a fake server holding this state. */
export async function renderReview(state: State) {
  const server = fakeServer(state);
  current = server;
  const screen = await render(
    <ReviewProvider initial={state}>
      <ReviewPage />
    </ReviewProvider>,
  );
  return { screen, server };
}

/** The hand-off page over a fake server that reports these items. */
export async function renderHandoff(state: State, items: readonly unknown[]) {
  const server = fakeServer(state);
  current = server;
  server.on("GET", "/api/report?format=json", () => items);
  const screen = await render(
    <ReviewProvider initial={state}>
      <Handoff />
    </ReviewProvider>,
  );
  return { screen, server };
}
