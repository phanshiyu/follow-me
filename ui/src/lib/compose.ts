import type { Anchor, NewComment, Severity, WireComment } from "./wire.ts";

export type BoxKind = "ask" | "flag";
export type Draft = {
  readonly body: string;
  readonly kind: BoxKind;
  readonly severity: Severity | null;
};

/** The comment a saved box posts. Ask makes a question; Flag a change request, pending or not. */
export function composeComment(
  anchor: Anchor,
  context: WireComment["context"],
  draft: Draft,
  pending: boolean,
): NewComment {
  return {
    anchor,
    context,
    body: draft.body,
    ...(draft.kind === "ask" ? { kind: "question" } : {}),
    ...(draft.severity === null ? {} : { severity: draft.severity }),
    ...(pending ? { pending: true } : {}),
  };
}
