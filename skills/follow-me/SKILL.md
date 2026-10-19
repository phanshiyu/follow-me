---
name: follow-me
description: Split the current branch's net change into fine, story-ordered commits that read like the author's thought process, then hand them to a human for hunk-by-hunk review. Use when the user asks to clean up, reorder, split or "tell the story" of a branch's commits, or to act on a follow-me review.
---

# follow-me

follow-me rewrites a branch as small commits ordered so a reader follows your thinking. It never
touches your working tree or index. It writes a new branch and keeps state in `.follow-me/<slug>/`.

Run every command from the repo root. If `follow-me` is not on PATH, ask the user how it is installed.

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
   positions, hunks and single lines.

## After a review

When the user says they finished reviewing:

1. `follow-me feedback` prints the review as markdown. Every comment has an id like `c_abc234`.
2. `follow-me prompt` now includes the previous plan and the open comments. Write a new draft that
   changes the plan where you agree and lists one entry per comment in `responses`:
   `{ "comment": "c_abc234", "status": "addressed" | "declined" | "deferred", "note": "..." }`.
   Say why when you decline. Do not leave a comment unanswered.
3. `follow-me check`, repair until green, then `follow-me apply`, and ask the user to review again.

## Rules

- The draft is the only file you write. Never run `git rebase`, `reset` or `commit` for this.
- Use unit ids exactly as printed. `h_x:0-3,7` takes change lines 0 to 3 and 7 of that hunk.
  A bare `h_x` takes whatever lines no other commit claimed.
- `f_` and `m_` units are whole; they never take line lists.

## Install

Copy or symlink this folder into the repo you want to use it in:

```sh
mkdir -p .claude/skills
ln -s /path/to/follow-me/skills/follow-me .claude/skills/follow-me
```

For every repo at once, link it into `~/.claude/skills/follow-me` instead.
