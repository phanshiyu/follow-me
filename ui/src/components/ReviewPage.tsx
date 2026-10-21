import { useReview } from "../store.tsx";
import { CommitSection } from "./CommitSection.tsx";

export function ReviewPage() {
  const { state } = useReview();
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 h-11 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-full max-w-[1232px] items-center gap-2 px-6 text-sm">
          <strong>follow-me</strong>
          <span className="text-muted-foreground">
            · {state.anchor.branch} → {state.anchor.baseRef} · plan v{state.version}
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-[1232px] px-6">
        {state.commits.map((commit) => (
          <CommitSection key={commit.index} commit={commit} />
        ))}
      </main>
    </div>
  );
}
