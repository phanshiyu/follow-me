# Design

follow-me splits a branch's net change into fine, ordered commits that read like
the author's thought process, lets a human review and comment hunk by hunk, and
hands the review back to a coding agent for the next plan version.

## The one idea that removes patching

Every unit comes from a single `git diff base..tip`. Hunks of one file are
disjoint in base coordinates, so a file's content after applying any subset of
changed lines is the base lines with the chosen `-` lines dropped and the chosen
`+` lines inserted. Order of assignment never matters and nothing can misapply.
There is no offset search and no fuzz. Two gates stand instead:

1. While parsing, every context and `-` line must equal the base blob at its
   position. A mismatch is a parser bug and aborts.
2. After projecting the last commit, every path's bytes and mode must equal the
   tip. Then git's own tree hash is compared once more after writing.

## Units

- `h_…` text hunk. The planner may take all of it, or a subset of its change
  lines (`h_x:0-3,7`). Every change line is used exactly once across the plan.
  A bare `h_x` takes whatever lines of that hunk no other commit claimed.
- `f_…` whole-file unit for content that cannot be projected line-wise: binary,
  symlink, gitlink, empty create or delete, type change.
- `m_…` mode flip of a text file present on both sides.

Ids are `prefix_` plus twelve hex of sha256 over path and hunk body without line
numbers, so moving the tip or re-extracting keeps ids of unchanged hunks.
Identical duplicates get `~2`, `~3` in diff order.

File existence per commit is derived from which change lines are applied, so
there are no separate create and delete units for text files.

## Plan, validation, apply

`validatePlan(diff, draft: unknown)` is pure and returns every issue at once or a
`ValidPlan` that carries each commit's projected tree changes. Only `plan.ts`
can construct a `ValidPlan`, so an unvalidated plan cannot reach the writer.

`writeBranch` builds commits with a temporary index file and `commit-tree`,
never touching the user's index or working tree. Author and committer come from
the tip commit and commit `i` of `n` gets committer time `tipTime - (n - 1 - i)`.
The branch ref moves only if it still points where the last apply left it.

Commits are signed when `git config --type=bool commit.gpgsign` is true; `--sign` and
`--no-sign` override it. `commit-tree` is plumbing and ignores `commit.gpgsign`, so apply
reads it and passes `-S` or `--no-gpg-sign`; `gpg.format` and `user.signingkey` then apply
as they do for `git commit`. SHAs are stable only when signing is off: openpgp, x509 and ecdsa
signatures differ on every run (ssh ed25519 happens to be deterministic). So the branch record
is what makes re-apply a no-op either way. `applied.json` stores the plan version, its hash,
the branch, its head and whether it was signed; when all match and the branch still points at
that head, apply writes nothing and prints `unchanged`. Otherwise `writeBranch` runs, and an
unsigned rewrite that yields the head the branch already has is `unchanged` too.

The split never lands on the branch being split, and never on a branch checked out in any
worktree, `--force` included; `--force` only lets apply move a branch follow-me did not create.
New blobs, trees and commits go to a quarantine directory inside the object store
(`GIT_OBJECT_DIRECTORY`, with the real store as an alternate) and are hard-linked in right
before `update-ref`, so a refused or failed apply leaves no refs and no objects.

## Review loop

`.follow-me/<branch-slug>/` holds `session.json` (the anchor), `draft.json`
(planner output), `plans/vN.json` (frozen on apply, deduplicated by hash),
`reviews/vN.json` (written once when a review ends), `reviews/vN.draft.json` (autosave of an
unfinished review), `applied.json` and, while apply runs or the review server hosts the session,
`lock`.
One writer per file.

Comments anchor to `(commit index, unit id, optional change lines)`, a commit
message, a commit position, or the whole plan, and snapshot the message and path
they pointed at. A comment is answered when a later plan lists it in
`responses`; nothing is stored on the comment. Unanswered comments are warnings,
not errors, so a human can still apply.

Two planners write the same draft format. An agent reads `follow-me prompt`
and writes `draft.json` itself. `follow-me plan` asks the Anthropic API.

## Many sessions

State is split so concurrent sessions share nothing they write.

- `.follow-me/` sits at `git rev-parse --show-toplevel` of the cwd. In a linked worktree that is
  the worktree itself, not the main checkout, so each worktree has its own `.follow-me/` and its
  own `.gitignore` in it. Two repos are two roots.
- Within a root, each branch has its own `<slug>/` directory. Slugs map `/` to `-`, so `a/b`
  and `a-b` would collide; `session.json` names its branch, and the second branch is refused.
- The only thing worktrees share is the repo: refs and the object store. Split branches are
  `<branch>-split` per session, so two worktrees write different refs, each by compare-and-swap.
  Objects are content-addressed and adopted with link, which never overwrites.
- Two agents on the same session is the one real shared writer, so apply, review and walk hold
  `<slug>/lock`, and the review server holds it for as long as it hosts the session. The lock is written whole to a temp file and linked into place, which fails
  like `open(wx)` when it exists. It records the pid; a lock whose pid is dead is taken over, and
  release removes it only if it still carries this process's token.
- Every session of a user shares one review server; see the next section.

`follow-me clean` converges a root to what live sessions need. It removes sessions whose branch
is gone, review drafts at or below the latest finished review, and locks, `*.<pid>.*.tmp` files
and object quarantines whose pid is dead. Plan versions stay; reviews refer to them. `--all`
removes `.follow-me/` and refuses while a live process holds a session.

## One server, many sessions

A user runs one review server, and it hosts every session they are reviewing, across repos and
worktrees. Its record lives in a per-user state dir, `$FOLLOW_ME_HOME`, else
`$XDG_STATE_HOME/follow-me`, else `~/.local/state/follow-me`, as `server.json`
(`{ pid, port, startedAt }`), with `server.log` beside it for a detached server's output. The
record is claimed like the session lock, by linking a complete temp file into place, so two
servers starting at once cannot both own it; the loser closes and attaches to the winner. A
record whose pid is dead or does not answer as ours is replaced.

The server keeps a registry, `Map<SessionId, HostedSession>`. A `SessionId` is 12 hex of sha256
over the session directory, so registering the same session again returns the same id and URL
instead of a second copy; registering it with another plan version is refused until the first
review ends. Each session is served at `/s/<id>/` with its API under `/s/<id>/api/`. `/` lists
every session with its repo, branch, mode, version and comment count, `/api/sessions` returns
the same list as JSON, and `/api/health` answers `{ "app": "follow-me", "pid" }` so a CLI can tell
our server from another program on the port.

`review` and `walk` prepare the plan under the session lock, then find the server: a live
`server.json` record, or a `--port` that answers as ours. If one runs, the CLI registers the
session with `POST /api/sessions` (session dir, mode, version, plan hash, lock token), prints the
URL and exits. Otherwise the CLI becomes the server in the foreground and waits for its own review
to end, or with `--detach` starts `follow-me server run` as a detached process and registers with
it. The registration carries the CLI's lock token and the server takes the lock over by token
before the CLI lets go, so exactly one live process owns a hosted session's lock and there is no
gap for another to take it. Running `review` again while the server holds the session prints the
same URL.

Ending a session writes `reviews/vN.json` exactly as a single review always did, removes the draft
and releases the lock. The server exits on its own once it has hosted no session for 30 seconds
(`FOLLOW_ME_IDLE_MS` overrides this, for tests), so a review started right after another reuses it.
`follow-me server stop` sends SIGTERM to the recorded pid, but only if that pid answers as our
server on the recorded port. On SIGTERM or Ctrl-C the server releases every lock and writes no
review; autosaved drafts come back when the session is opened again. It removes `server.json` on
every exit.

A `--port` held by our own server means attach. Held by anything else, the server listens on a
free port and the CLI prints `port N is in use by another program, using M`. Binding never fails
with EADDRINUSE.

## Reviewer mode and playback

The same engine serves a second persona. A reviewer runs `follow-me walk` on a branch someone else
wrote, watches it being written commit by commit with narration read aloud, and comments on the
code. Nothing is applied.

Narration lives in the plan. A commit and any unit ref may carry `narration`, so one planner call
produces both the order and the voice-over, and validation passes it through to
`ProjectedCommit`. A unit entry with narration serializes as `{ "unit": "h_x:0-3", "narration": … }`;
without it the entry stays a plain string, so older plans and their hashes are unchanged. The walk
prompt shares the unit dump and the rules with the split prompt and differs only in its goal.

`Review.mode` is `split` or `walk`, and a file without it reads as `split`. A walk review is a code
review for the author, not plan feedback, so `lastReview` ignores it: walk comments never reach the
planner as comments to answer. `follow-me feedback` renders a walk review grouped by file, quoting
each hunk as it reads in that commit with its line number on the tip. Walk reviews share
`reviews/vN.json` with plan reviews, so one plan version gets one review of either kind.

Playback is a script of steps built from the projected commits: a commit begins (its narration,
else its title, is spoken), each unit begins (its narration is spoken and waited for), then each of
the commit's own change lines appears or fades out. The UI holds a position into that script, and
every line's look is a pure function of the position (`ui/playback.js`), so seeking, pausing and
re-rendering never disagree. Speech uses the browser's `speechSynthesis`; muting keeps the timing
without audio, and a timeout bounds engines that never report the end of an utterance.

## Interactive loop

A review is a conversation, so the agent talks to the review server, not to files. The server
holds each hosted session's state in memory and appends everything that happens to an event log;
files stay the durable record written as it goes (`reviews/vN.draft.json`) and at the end.

- **Event log.** `seq` counts from 1 at registration and never repeats. `GET api/events?since=&timeout=`
  long-polls it (default 25 s, at most 60 s) and returns `{ seq, events }` at once when there is news,
  else `{ seq, events: [] }` at the timeout. `GET api/events/stream` serves the same log as
  Server-Sent Events: it replays after `since` (or `Last-Event-ID`), pushes each new event, pings every
  15 s and closes after `ended`. Every mutation emits one event: `comment`, `comment-updated`,
  `comment-deleted`, `reply`, `concern`, `resolved`, `version`, `ended`. `since` beyond the log is a 409,
  because a restarted server restarts the count. `api/state` carries the current `seq`, so a page
  that reads state and then polls from it misses nothing.
- **Replies.** `Comment.replies` holds the conversation under a comment, posted to
  `POST api/comments/<cid>/replies` by the agent (`follow-me reply`) or the reviewer. They are
  autosaved and written into the review. A page's `PUT` of a comment never overwrites them.
- **In-place swap.** `POST api/version { version, hash }` moves the hosted session to a newer frozen
  plan under the same id and URL. The new plan loads first through the same loader as a fresh
  registration, with the lock the server already holds, so a plan that no longer fits changes nothing.
  Then the old version's review is finalized to `reviews/vN.json` (and `vN.md`) if anything was said,
  and the comment set starts empty. `api/state.previous` is `{ version, comments, responses }`: the
  comments of the review before this version, finished or still an autosave, and what this plan
  answered. `follow-me apply` does this when the server hosts the session, writing the branch under the
  server's lock. Walk sessions can be swapped through the endpoint, but no command does it yet.
- **Validation sees live comments.** `session.priorReview` returns the autosave of an unfinished
  review when it is newer than every finished one, so `check` and `apply` accept responses to comments
  that exist only on the open page.
- **Report.** `renderReport` in `prompt.ts` is the one renderer: reviewer comments and the agent's kept
  concerns by file in diff order and by line, severity in each heading, the hunk quoted as that commit
  writes it, both voices, replies under their comment, questions and their answers last. Undecided and
  dismissed concerns are left out. `follow-me feedback` and `report`, `GET api/report` and the `vN.md`
  written on end all call it.
- **Concerns and questions.** A plan may carry `concerns` on commits and unit refs; validation derives
  `k_` ids, allows one per unit, and the reviewer's decisions live in `Review.concerns`. A comment of
  `kind: "question"` is answered by a response with status `answered` whose `at` points at narration or a
  diagram in the new plan; validation rejects an answer that points at nothing.
