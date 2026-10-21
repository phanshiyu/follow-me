---
name: follow-me
description: Split the current branch's net change into fine, story-ordered commits that read like the author's thought process, then hand them to a human for hunk-by-hunk review. Also plans a narrated walk-through of someone else's branch for a reviewer. Use when the user asks to clean up, reorder, split or "tell the story" of a branch's commits, to walk through or review a branch, or to act on a follow-me review or code review.
---

# follow-me

follow-me rewrites a branch as small commits ordered so a reader follows your thinking. It never
touches your working tree or index. It writes a new branch and keeps state in `.follow-me/<slug>/`.

Run every command from the repo root. If `follow-me` is not on PATH, ask the user how to run it.

## First pass

1. `follow-me extract [--base main]` snapshots the diff from the base branch to the tip.
2. `follow-me prompt` prints your instructions and every unit (hunk, file or mode change) with an id.
   Read all of it. It names the exact path to write, `.follow-me/<slug>/draft.json`.
3. Write that draft. Order commits so scaffolding and types come before their uses, a failing test
   comes before its fix, renames come before edits, and each commit carries one idea. Commits need
   not compile. Every change line is used exactly once, and the last commit must cover every unit.
4. `follow-me check` validates the draft and prints every issue at once. Fix the draft and re-run
   until it is green. Do not edit around an issue by hand-waving it; unassigned and duplicate
   lines are real mistakes.
5. `follow-me apply` freezes the plan as the next version and writes the branch.
6. Tell the user to run `follow-me review`. It opens a local page where they comment on messages,
   positions, hunks and single lines. If you start it yourself, use `follow-me review --wait --no-open`,
   which prints the page URL to give the user and returns once they end the review, so you can go
   straight on to `follow-me feedback`; one server hosts every session the user has open.

## After a review

When the user says they finished reviewing:

1. `follow-me feedback` prints the review as markdown. Every comment has an id like `c_abc234`.
2. `follow-me prompt` now includes the previous plan and the open comments. Write a new draft that
   changes the plan where you agree and lists one entry per comment in `responses`:
   `{ "comment": "c_abc234", "status": "addressed" | "declined" | "deferred", "note": "..." }`.
   Say why when you decline. Do not leave a comment unanswered.
3. `follow-me check`, repair until green, then `follow-me apply`, and ask the user to review again.

## As a reviewer

`follow-me walk` is for someone reading a branch they did not write. It plays the branch back
commit by commit in the browser, one chunk of change at a time: it reads your narration aloud,
then shows the lines it explains. The reviewer comments on the code. Nothing is applied and no branch is written.

1. `follow-me walk [--branch <name>]` opens the session. If there is no plan yet, it
   prints two commands and stops. Run the first, `follow-me prompt --walk`, and read all of it.
2. Write the draft it names. The order rules are the same, and every commit also gets a
   `narration`: what the author is thinking while writing it, first person, present tense, two or
   three sentences, no markdown. Give a unit narration as `{ "unit": "h_x:0-3", "narration": "..." }`
   when the why of that hunk is not obvious from the commit's narration. Narration is spoken, so
   it names no symbols the listener has to see spelled out and never describes a picture.
   Optionally add a `diagram`, Mermaid source drawn beside the code, to a commit or a unit
   (`{ "unit": "h_x", "diagram": "flowchart LR\n  a --> b" }`). Use one only for what prose
   carries badly: data flow between modules, a state machine, a call graph, or the before and
   after shape of a structure. Most commits need none. Its first line must name the diagram type,
   such as `flowchart`, `sequenceDiagram` or `stateDiagram-v2`; `follow-me check` rejects others.
3. `follow-me check` until green, then tell the user to run `follow-me walk` again. Do not apply.

When you are the author's agent and `follow-me feedback --walk` prints a `# Code review`, the review
came from a walk. It quotes each commented line as a diff excerpt with its line number on the
branch. Address every item in the code on the branch itself, then tell the user what you changed
and what you declined and why. Do not write a follow-me draft or `responses` for it; those answer
plan reviews only.

## Rules

- The draft is the only file you write. Never run `git rebase`, `reset` or `commit` for this.
- Use unit ids exactly as printed. `h_x:0-3,7` takes change lines 0 to 3 and 7 of that hunk.
  A bare `h_x` takes whatever lines no other commit claimed.
- `f_` and `m_` units are whole; they never take line lists.

## Interactive loop

While the review page is open the reviewer comments and asks questions live, and you answer without
closing the page. Everything goes through the review server.

1. `follow-me watch [--since <seq>] [--timeout <seconds>]` blocks until the reviewer does something and
   prints it (`--json` for one JSON object per line, `--follow` to stream until the review ends). It
   exits 0 with news, 2 when nothing happened, and prints the `--since` to use next. Run it again in a
   loop; stop when it reports that the review ended.
2. Answer a question or comment in place with `follow-me reply <commentId> --body "..."`, adding
   `--diagram <file>` with Mermaid source when a picture explains it. This needs no new plan.
   `follow-me explain [--commit <n>] [--unit <id>] [--lines <a-b>] --body "..." [--diagram <file>]`
   starts a thread yourself, before anyone asks: about the whole plan, a commit, or change lines of a
   unit. `watch` does not echo it back to you. A comment on rows marked `>` that are plain context is about
   code this branch leaves alone: explain it or point at the commit that last touched it, and do not move
   lines because of it.
3. When the plan itself should change, write a new draft whose `responses` answer the comments
   (`"status": "answered"` with `"at"` for questions), `follow-me check`, then `follow-me apply`. While the
   page is open, apply swaps it to the new version at the same URL and keeps the old comments.
4. At the end, `follow-me report` prints one consolidated report of the issues you and the reviewer
   raised, by file and line, with questions and answers last. It is also saved as
   `.follow-me/<slug>/reviews/vN.md`. Give it to the author.

In a walk you may also raise `concerns` (see `follow-me prompt --walk`); the reviewer keeps or dismisses
each, and only kept ones reach the report.
