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
  ServerEvent as ServerEventBase,
  SessionAnchor,
  Severity,
  Unit,
  UnitId,
} from "../../../src/types.ts";

export type {
  Anchor,
  Comment,
  CommentId,
  CommentResponse,
  ConcernDecision,
  ConcernId,
  HunkLine,
  PlacedConcern,
  PreviousVersion,
  ProjectedCommit,
  Reply,
  Severity,
  TextHunk,
  Unit,
  UnitId,
  UnitRef,
} from "../../../src/types.ts";

/** Every comment reaches the agent as it is saved, so the page ignores any `pending` mark. */
export type WireComment = Omit<Comment, "pending">;

/**
 * Where one comment of the previous plan version landed in this one. unit and offsets name rows of
 * the new plan; changed says the code under them is not what the reviewer commented on.
 */
export type Carried = {
  readonly comment: CommentId;
  /** null when the code is gone from the new plan. */
  readonly unit: UnitId | null;
  /** Rows of the unit's body, 0-based; null when the unit has none to point at. */
  readonly offsets: readonly number[] | null;
  readonly changed: boolean;
  readonly path: string;
  readonly newLine: number | null;
};

/** The version event, with what the swap did to the previous version's comments. */
export type VersionEvent = Extract<ServerEventBase, { type: "version" }> & {
  readonly carried?: readonly Carried[];
};

export type ServerEvent = Exclude<ServerEventBase, { type: "version" }> | VersionEvent;

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
  /** One entry per comment of `previous`, absent from a server that does not carry threads. */
  readonly carried?: readonly Carried[];
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
