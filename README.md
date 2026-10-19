# follow-me

Read a branch the way it was thought, not the way it was committed.

follow-me takes a branch's net change and splits it into fine commits ordered so a reader
can follow the author's thought process. Individual commits need not compile. The last
commit's tree is byte-identical to the original tip, and follow-me proves it with git's own
tree hash. Then it serves a local page where you walk the commits one by one, comment on any
hunk or line, and hand the comments to a coding agent for the next version.

Two people use it:

- **The author** runs extract, check, apply and review to turn a messy branch into a readable
  stack before asking for review. Comments on the split go back to the agent, which writes
  the next plan.
- **The reviewer** runs `follow-me walk` on someone else's branch to watch it being written,
  with narration spoken as each line appears, and leaves comments on the code. The result is
  a code review for the author.

Inspired by [spark-joy](https://github.com/Dansyuqri/spark-joy)'s "split your own changes".

## Install

Requires Node 24 or newer and git. There is no build step; Node runs the TypeScript sources.

```sh
git clone https://github.com/<you>/follow-me
cd follow-me && npm install && npm link   # puts `follow-me` on your PATH
```

## Author flow

Run everything from the repo whose branch you want to split, with that branch checked out.

```sh
follow-me extract --base main      # anchor a session, list the units (hunks, files, modes)
follow-me prompt                   # the planner prompt, for a coding agent to read
# the agent writes .follow-me/<branch>/draft.json
follow-me check                    # every problem with the draft, at once
follow-me apply                    # write <branch>-split, prove the tree matches
follow-me review                   # open the review page; end it to save reviews/v1.json
follow-me feedback                 # the comments as markdown, for the agent
```

With Anthropic credentials in the environment, `follow-me plan` writes the draft itself.
Otherwise the Claude Code skill in `skills/follow-me/` does it; link it into
`.claude/skills/follow-me/` and ask Claude to split the branch.

After a review, the agent reads the comments, writes a new draft that answers each one in
`responses`, and runs `check` and `apply` again. Plans are versioned under
`.follow-me/<branch>/plans/`, reviews under `reviews/`, and a comment counts as answered when
a later plan lists it.

## Reviewer flow

```sh
git checkout their-branch
follow-me walk --base main         # extract, plan, and open playback
```

Playback walks the commits in order, speaks the narration the planner wrote, and types each
added line out. Space pauses, `n` and `p` move between commits, and the speed and voice are
adjustable. Pause on a line to comment on it. Finishing writes `reviews/vN.json`, and
`follow-me feedback` renders it as a code review grouped by file.

Narration uses the browser's built-in speech synthesis. No key, no network.

## How it works

Every unit comes from one `git diff base..tip`, so hunks of a file never overlap in base
coordinates. A commit's version of a file is the base lines with that commit's change lines
swapped in. Nothing is patched, so hunks can be assigned in any order and split by line.
See `docs/DESIGN.md`.

The user's working tree, index and branches are never touched. Commits are built in a
temporary index with dates derived from the tip, so the same plan always yields the same
SHAs and re-running `apply` is a no-op.

## Safety

- `apply` refuses to move a branch it did not create unless `--force`.
- The review server binds `127.0.0.1` only and rejects cross-origin requests.
- Everything under `.follow-me/` is ignored by git.
- Outside the repo, follow-me writes only its state dir (`~/.local/state/follow-me`, or
  `$XDG_STATE_HOME/follow-me`), which holds the review server's `server.json` and `server.log`.
- One review server per user hosts every session. `follow-me server stop` signals it only after
  it answers as follow-me on its recorded port, so a reused pid is never killed.

Three guarantees hold across sessions. The original branch is never written. `apply` puts the
split on `<branch>-split` or `--name`, and refuses the branch being split and any branch checked
out in a worktree, even with `--force`. Sessions are isolated per worktree. Each worktree keeps
its own `.follow-me/`, each branch its own directory, and a lock stops two agents from applying or
reviewing one session at once. `follow-me clean` removes leftovers: sessions of deleted branches,
review drafts no review can resume, and files of processes that died.

## Development

```sh
npm run check        # biome, strict tsc, node --test
node bin/follow-me.ts <command>
```

Tests run against real git repositories built by `test/fixture-repo.ts`.
Decisions are logged in `docs/decisions.tsv`.
