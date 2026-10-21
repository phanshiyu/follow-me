/**
 * Domain types shared by every module. This file holds no logic.
 *
 * Module map (any flow traces through at most three files):
 *   diff.ts     git diff semantics: parse raw git output into a Diff, project file content
 *               for any subset of applied change lines. Pure.
 *   plan.ts     plan semantics: parse plan JSON, resolve selections, check coverage,
 *               project every commit, prove the last one equals the tip. Pure.
 *   git.ts      the only module that spawns git: load a Diff, write a branch from a ValidPlan.
 *   session.ts  the .follow-me/<slug>/ layout: session anchor, plans, reviews, draft.
 *   comments.ts the wire formats of review state: comments, replies, concern decisions, the
 *               review file, the autosaved draft and the server's events. Pure parsers.
 *   prompt.ts   the planner prompt for an agent, the feedback and the consolidated report.
 *   server.ts   the review server: a registry of hosted sessions, their JSON API, and ui/.
 *   host.ts     the one server per user: its record in the state dir, attach, start, stop.
 *   cli.ts      argv -> one call into the modules above.
 */

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** "h_" + 12 hex of sha256(path, hunk body without line numbers), "~n" for the n-th duplicate. */
export type HunkId = Brand<string, "HunkId">;
/** "f_" whole-file unit (binary, symlink, gitlink, empty file, type change). */
export type FileUnitId = Brand<string, "FileUnitId">;
/** "m_" mode flip of a text file present on both sides. */
export type ModeUnitId = Brand<string, "ModeUnitId">;
export type UnitId = HunkId | FileUnitId | ModeUnitId;
export type Sha = Brand<string, "Sha">;
export type CommentId = Brand<string, "CommentId">;
/** "r_" + 6 base32. */
export type ReplyId = Brand<string, "ReplyId">;
/** "k_" + 8 hex of sha256 over the unit, the lines and the text, so re-planning keeps it. */
export type ConcernId = Brand<string, "ConcernId">;
export type PlanVersion = Brand<number, "PlanVersion">;
/** Repo-relative path exactly as git prints it. */
export type RepoPath = Brand<string, "RepoPath">;

export type FileMode = "100644" | "100755" | "120000" | "160000";
export type Entry = { readonly mode: FileMode; readonly blob: Sha };

/** One line including its terminator, so lines.join("") is byte-identical to the blob. */
export type Line = string;

export type HunkLine =
  | { readonly op: " "; readonly text: Line }
  | { readonly op: "-"; readonly text: Line; readonly change: number }
  | { readonly op: "+"; readonly text: Line; readonly change: number };

export type TextHunk = {
  readonly kind: "hunk";
  readonly id: HunkId;
  readonly path: RepoPath;
  /** 0-based index into the base file's lines where body[0] sits. */
  readonly oldStart: number;
  readonly body: readonly HunkLine[];
  /** Number of +/- lines. Valid change indices are [0, changeCount). */
  readonly changeCount: number;
};

export type FileUnit = {
  readonly kind: "file";
  readonly id: FileUnitId;
  readonly path: RepoPath;
  readonly before: Entry | null;
  readonly after: Entry | null;
  readonly reason: "binary" | "symlink" | "gitlink" | "empty" | "typechange";
};

export type ModeUnit = {
  readonly kind: "mode";
  readonly id: ModeUnitId;
  readonly path: RepoPath;
  readonly from: FileMode;
  readonly to: FileMode;
};

export type Unit = TextHunk | FileUnit | ModeUnit;

/**
 * A text file touched by at least one hunk or a mode flip (then hunks is empty and the mode
 * unit writes the base bytes under the new mode). Existence per commit is derived:
 * present on both sides: always present. base null: present once any change line is
 * applied. tip null: present until every change line is applied.
 */
export type TextFile = {
  readonly path: RepoPath;
  readonly base: { readonly entry: Entry; readonly lines: readonly Line[] } | null;
  readonly tip: { readonly entry: Entry; readonly bytes: string } | null;
  /** Sorted by oldStart and disjoint in base coordinates, which git guarantees. */
  readonly hunks: readonly TextHunk[];
};

export type Diff = {
  readonly base: Sha;
  readonly tip: Sha;
  readonly baseTree: Sha;
  readonly tipTree: Sha;
  /** Insertion order is git diff order, which keeps the prompt stable. */
  readonly units: ReadonlyMap<UnitId, Unit>;
  readonly textFiles: ReadonlyMap<RepoPath, TextFile>;
};

/** Which change lines of a unit a commit takes. "rest" means every line no other commit claimed. */
export type Selection =
  | { readonly kind: "rest" }
  | { readonly kind: "lines"; readonly changes: readonly number[] };
/**
 * narration is what the author is thinking as this unit is written, spoken during playback.
 * diagram is Mermaid source the page draws beside the code while playback is on this unit.
 */
export type UnitRef = {
  readonly unit: UnitId;
  readonly select: Selection;
  readonly narration?: string;
  readonly diagram?: string;
  readonly concerns?: readonly Concern[];
};

export type Severity = "blocker" | "major" | "minor";
export type ConcernKind = "bug" | "missing-test" | "naming" | "risk";

/**
 * Something the planning agent would raise in a pull request, in its voice as a reviewer. Written
 * without an id; validation derives one. lines are change indices of the unit, allowed only on a
 * unit ref.
 */
export type Concern = {
  readonly severity: Severity;
  readonly kind: ConcernKind;
  readonly text: string;
  readonly lines?: readonly number[];
};

/** A concern as validation carries it into a projected commit: with its id and its unit. */
export type PlacedConcern = Concern & {
  readonly id: ConcernId;
  /** Absent for a concern on the commit as a whole. */
  readonly unit?: UnitId;
};

/**
 * narration is the author thinking aloud while writing this commit: first person, present tense.
 * diagram is Mermaid source for the shape the commit builds, drawn beside its code.
 */
export type PlannedCommit = {
  readonly message: string;
  readonly narration?: string;
  readonly diagram?: string;
  readonly concerns?: readonly Concern[];
  readonly units: readonly UnitRef[];
};
/** "answered" is valid only for a question. */
export type ResponseStatus = "addressed" | "declined" | "deferred" | "answered";
export type CommentResponse = {
  readonly comment: CommentId;
  readonly status: ResponseStatus;
  readonly note: string;
  /** Where in this plan the explanation lives. commit is 1-based, as the prompt numbers commits. */
  readonly at?: { readonly commit: number; readonly unit?: UnitId };
};

/**
 * Wire format of plans/vN.json and draft.json. Unit refs serialize as "h_x" or "h_x:0-3,7", or as
 * { "unit": "h_x:0-3", "narration": "...", "diagram": "..." } when they carry either.
 */
export type PlanFile = {
  readonly schema: "follow-me/plan@1";
  readonly base: Sha;
  readonly tip: Sha;
  readonly commits: readonly PlannedCommit[];
  readonly responses: readonly CommentResponse[];
};

export type TreeChange =
  | {
      readonly path: RepoPath;
      readonly op: "write";
      readonly mode: FileMode;
      readonly bytes: string;
    }
  | { readonly path: RepoPath; readonly op: "link"; readonly entry: Entry }
  | { readonly path: RepoPath; readonly op: "delete" };

export type ProjectedCommit = {
  readonly index: number;
  readonly message: string;
  readonly narration?: string;
  readonly diagram?: string;
  /** Every concern of the commit: its own first, then those of its unit refs in order. */
  readonly concerns?: readonly PlacedConcern[];
  /** Hunk selections resolved to explicit lines; whole-file and mode units stay "rest". */
  readonly refs: readonly UnitRef[];
  readonly changes: readonly TreeChange[];
};

export type PlanIssue =
  | { readonly kind: "malformed"; readonly at: string; readonly reason: string }
  | { readonly kind: "stale"; readonly planTip: string; readonly sessionTip: Sha }
  | { readonly kind: "empty-message"; readonly commit: number }
  | { readonly kind: "empty-commit"; readonly commit: number }
  | { readonly kind: "unknown-unit"; readonly commit: number; readonly ref: string }
  | {
      readonly kind: "bad-selection";
      readonly commit: number;
      readonly unit: UnitId;
      readonly reason: string;
    }
  | {
      readonly kind: "duplicate";
      readonly unit: UnitId;
      readonly changes: readonly number[];
      readonly commits: readonly [number, number];
    }
  | {
      readonly kind: "unassigned";
      readonly unit: UnitId;
      readonly path: RepoPath;
      readonly changes: readonly number[];
    }
  | {
      readonly kind: "path-conflict";
      readonly commit: number;
      readonly file: RepoPath;
      readonly under: RepoPath;
    }
  | { readonly kind: "unknown-response"; readonly comment: string }
  | { readonly kind: "bad-answer"; readonly comment: CommentId; readonly reason: string }
  | { readonly kind: "bad-concern"; readonly commit: number; readonly reason: string }
  | {
      readonly kind: "too-many-concerns";
      readonly unit: UnitId;
      readonly commits: readonly number[];
    }
  | {
      readonly kind: "final-mismatch";
      readonly path: RepoPath;
      readonly expected: Entry | null;
      readonly got: string;
    };

/** Non-blocking findings the planner should still see. */
export type PlanWarning =
  | { readonly kind: "unanswered"; readonly comment: CommentId; readonly review: PlanVersion }
  /** A title over LONG_TITLE characters; the page clamps titles, so long ones lose their end. */
  | { readonly kind: "long-title"; readonly commit: number; readonly length: number }
  | { readonly kind: "question-addressed"; readonly comment: CommentId };

export type Anchor =
  | {
      readonly kind: "hunk";
      readonly unit: UnitId;
      readonly commit: number;
      readonly changes: readonly number[] | null;
      /**
       * Rows of the unit's body the reviewer picked, 0-based and strictly ascending, context rows
       * included. changes then holds the change indices among them and may be empty.
       */
      readonly offsets?: readonly number[];
    }
  | { readonly kind: "message"; readonly commit: number }
  | { readonly kind: "position"; readonly commit: number }
  | { readonly kind: "plan" };

export type ReplyAuthor = "agent" | "reviewer";

/** One turn of the conversation under a comment. diagram is Mermaid source. */
export type Reply = {
  readonly id: ReplyId;
  readonly author: ReplyAuthor;
  readonly body: string;
  readonly diagram?: string;
  readonly createdAt: string;
};

/**
 * Comments snapshot what they pointed at, so a later reader need not load the old plan. Absent
 * kind is a change request; "question" asks for an explanation. context.lines holds the selected
 * rows as text, for when the unit no longer exists.
 */
export type Comment = {
  readonly id: CommentId;
  readonly anchor: Anchor;
  readonly context: {
    readonly commitMessage: string;
    readonly path: RepoPath | null;
    readonly lines?: readonly string[];
  };
  readonly body: string;
  readonly createdAt: string;
  readonly kind?: "question";
  /** The question this one asks again. */
  readonly follows?: CommentId;
  readonly severity?: Severity;
  /**
   * A flag made on the page and not yet submitted. It is stored and autosaved, but the agent does
   * not see it until the reviewer submits. A question is never pending.
   */
  readonly pending?: true;
  readonly replies?: readonly Reply[];
  /** Absent means the reviewer. "agent" is a thread the agent started, for example an explanation. */
  readonly author?: "agent";
  /** Mermaid source, only on an agent's comment (a reviewer's comment has none). */
  readonly diagram?: string;
};

/** The reviewer's verdict on one of the agent's concerns; severity overrides the agent's. */
export type ConcernDecision = {
  readonly concern: ConcernId;
  readonly decision: "kept" | "dismissed";
  readonly severity?: Severity;
  readonly note?: string;
  /** ISO time the server recorded the decision, so the timeline can be rebuilt after a restart. */
  readonly decidedAt?: string;
};

/**
 * "split" reviews the plan for the author's next draft. "walk" is a reviewer's code review of the
 * branch itself; the plan only orders the playback.
 */
export type ReviewMode = "split" | "walk";

/** Wire format of reviews/vN.json, written once when the review session ends. */
export type Review = {
  readonly schema: "follow-me/review@1";
  readonly mode: ReviewMode;
  readonly planVersion: PlanVersion;
  readonly planHash: string;
  readonly endedAt: string;
  readonly comments: readonly Comment[];
  readonly concerns?: readonly ConcernDecision[];
  /** Questions from earlier versions the reviewer marked resolved during this review. */
  readonly resolved?: readonly CommentId[];
  /** Items the reviewer left out of the hand-off to the merge request. */
  readonly excluded?: Excluded;
};

/** Comments and agent concerns kept out of the report's main list and of `report --json`. */
export type Excluded = {
  readonly comments: readonly CommentId[];
  readonly concerns: readonly ConcernId[];
};

/** The autosave of an unfinished review, in the same shape its Review will have. */
export type ReviewDraft = {
  readonly comments: readonly Comment[];
  readonly concerns: readonly ConcernDecision[];
  readonly resolved: readonly CommentId[];
  readonly excluded: Excluded;
};

/** The version before a swap or a fresh open: its comments and what the new plan answered. */
export type PreviousVersion = {
  readonly version: PlanVersion;
  readonly comments: readonly Comment[];
  readonly responses: readonly CommentResponse[];
};

/** One entry of the hosted session's append-only log. seq starts at 1 and never repeats. */
export type ServerEvent = { readonly seq: number } & (
  | { readonly type: "comment" | "comment-updated"; readonly comment: Comment }
  | { readonly type: "comment-deleted"; readonly id: CommentId }
  | { readonly type: "reply"; readonly commentId: CommentId; readonly reply: Reply }
  | {
      readonly type: "concern";
      readonly concernId: ConcernId;
      readonly decision: "kept" | "dismissed";
      readonly severity?: Severity;
      readonly note?: string;
      readonly decidedAt?: string;
    }
  | { readonly type: "resolved"; readonly commentId: CommentId; readonly resolved: boolean }
  | { readonly type: "version"; readonly version: PlanVersion; readonly hash: string }
  /** The reviewer released every pending flag; the comment events that follow carry them. */
  | { readonly type: "submitted" }
  | { readonly type: "ended"; readonly review: string }
);

/** Wire format of session.json. */
export type SessionAnchor = {
  readonly schema: "follow-me/session@1";
  readonly branch: string;
  readonly baseRef: string;
  readonly base: Sha;
  readonly tip: Sha;
  readonly tipTree: Sha;
};

/** Wire format of applied.json. */
export type Applied = {
  readonly schema: "follow-me/applied@1";
  readonly version: PlanVersion;
  readonly branch: string;
  readonly head: Sha;
  /** planHash of the applied plan; null in records written before it was stored. */
  readonly hash: string | null;
  /** Whether the commits were signed; null in records written before it was stored. */
  readonly signed: boolean | null;
};

/** Comment status is derived: the response in a later plan, else open. */
export type CommentStatus =
  | { readonly kind: "open" }
  | { readonly kind: "answered"; readonly in: PlanVersion; readonly response: CommentResponse };

/** Proves which process holds a session's lock; a handoff names the token it takes over. */
export type LockToken = Brand<string, "LockToken">;

/** 12 hex of sha256 over the session directory, so one session always gets one URL. */
export type SessionId = Brand<string, "SessionId">;

/** Wire format of <state dir>/server.json, present while the user's review server runs. */
export type ServerRecord = {
  readonly pid: number;
  readonly port: number;
  readonly startedAt: string;
};

/** One row of GET /api/sessions and of the index page. */
export type HostedSummary = {
  readonly id: SessionId;
  readonly url: string;
  readonly repo: string;
  readonly branch: string;
  readonly mode: ReviewMode;
  readonly version: PlanVersion;
  readonly comments: number;
};
