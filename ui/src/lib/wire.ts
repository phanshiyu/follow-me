// The server's JSON as the page reads it. The domain types are the contract; this file only adds
// the fields the server owner is landing beside this page (exclusions, the report).

import type {
  Comment,
  CommentId,
  ConcernDecision,
  ConcernId,
  PlanVersion,
  PreviousVersion,
  ProjectedCommit,
  ReviewMode,
  SessionAnchor,
  Severity,
  Unit,
} from "../../../src/types.ts";

export type {
  Anchor,
  CommentId,
  CommentResponse,
  ConcernDecision,
  ConcernId,
  HunkLine,
  PlacedConcern,
  PreviousVersion,
  ProjectedCommit,
  Reply,
  ServerEvent,
  Severity,
  TextHunk,
  Unit,
  UnitId,
  UnitRef,
} from "../../../src/types.ts";

/** Every comment reaches the agent as it is saved, so the page ignores any `pending` mark. */
export type WireComment = Omit<Comment, "pending">;

/** GET api/state. */
export type State = {
  readonly mode: ReviewMode;
  readonly anchor: SessionAnchor;
  readonly version: PlanVersion;
  readonly planHash: string;
  readonly commits: readonly ProjectedCommit[];
  readonly units: readonly Unit[];
  readonly comments: readonly WireComment[];
  readonly concerns: readonly ConcernDecision[];
  readonly resolved: readonly CommentId[];
  readonly seq: number;
  readonly previous: PreviousVersion | null;
  /** Hand-off items the reviewer left out of the merge request. */
  readonly excluded?: {
    readonly comments: readonly CommentId[];
    readonly concerns: readonly ConcernId[];
  };
};

/** What the page posts to api/comments; the server mints id and createdAt. */
export type NewComment = Omit<WireComment, "id" | "createdAt" | "replies">;

/** One item of GET api/report?format=json. Line numbers are the original branch's. */
export type ReportItem = {
  /** Not sent by every server yet; the page then finds the item by its words. */
  readonly id?: string;
  readonly path: string | null;
  readonly oldPath: string | null;
  readonly newLine: number | null;
  readonly oldLine: number | null;
  readonly startNewLine: number | null;
  readonly startOldLine: number | null;
  readonly severity: Severity | null;
  readonly kind: "flag" | "question" | "concern";
  /** Markdown, ready to post. */
  readonly body: string;
  readonly thread: readonly { readonly author: "reviewer" | "agent"; readonly body: string }[];
  readonly resolved: boolean;
  readonly excluded: boolean;
};
