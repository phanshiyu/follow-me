import { useEffect, useState } from "react";
import { ReviewPage } from "./components/ReviewPage.tsx";
import { api } from "./lib/api.ts";
import { navigate, useRoute } from "./lib/route.ts";
import type { State } from "./lib/wire.ts";
import { ReviewProvider } from "./store.tsx";

export function App() {
  const route = useRoute();
  const [state, setState] = useState<State | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    api
      .state()
      .then(setState)
      .catch((error: unknown) =>
        setFailure(error instanceof Error ? error.message : String(error)),
      );
  }, []);
  if (failure !== null) {
    return (
      <main className="mx-auto max-w-xl p-10 text-sm">
        <h1 className="mb-2 font-semibold text-lg">This review is not available</h1>
        <p className="text-muted-foreground">{failure}</p>
        <p className="mt-4">
          <a className="underline" href="/">
            All sessions
          </a>
        </p>
      </main>
    );
  }
  if (state === null)
    return <main className="p-10 text-muted-foreground text-sm">Loading the review…</main>;
  return (
    <ReviewProvider initial={state}>
      {route === "report" ? <Submitted /> : <ReviewPage />}
    </ReviewProvider>
  );
}

function Submitted() {
  return (
    <main className="mx-auto max-w-xl p-10 text-sm">
      <h1 className="mb-2 font-semibold text-lg">Review submitted</h1>
      <button type="button" className="underline" onClick={() => navigate("review")}>
        Back to review
      </button>
    </main>
  );
}
