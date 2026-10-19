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
the tip commit and commit `i` of `n` gets committer time `tipTime - (n - 1 - i)`,
so the same plan yields the same SHAs and re-running is a no-op. The branch ref
moves only if it still points where the last apply left it.

## Review loop

`.follow-me/<branch-slug>/` holds `session.json` (the anchor), `draft.json`
(planner output), `plans/vN.json` (frozen on apply, deduplicated by hash),
`reviews/vN.json` (written once when a review ends) and `applied.json`.
One writer per file.

Comments anchor to `(commit index, unit id, optional change lines)`, a commit
message, a commit position, or the whole plan, and snapshot the message and path
they pointed at. A comment is answered when a later plan lists it in
`responses`; nothing is stored on the comment. Unanswered comments are warnings,
not errors, so a human can still apply.

Two planners write the same draft format. An agent reads `follow-me prompt`
and writes `draft.json` itself. `follow-me plan` asks the Anthropic API.

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
