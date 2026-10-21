# Dogfood

The repo splits its own recent history with the naive planner and proves the result: one `wip:` commit per touched file, every file parsing, and a final tree equal to the original tip. CI runs the same script as its `dogfood` job.

## Sub-features

- `dogfood-run` clones the repo, branches `dogfood` at HEAD and runs extract, `plan --naive`, `check`, `apply` with `HEAD~6` as the base.
- `dogfood-syntax` runs the syntax gate on the repo's own TypeScript, JSON and shell sources and passes.
- `dogfood-proof` asserts the `proof:` line says `equals` and `git status --porcelain` is empty.
- `dogfood-isolation` uses a throwaway `FOLLOW_ME_HOME` and removes every temp directory on exit.

## How to get to it (user POV)

- Run `scripts/dogfood.sh` from a checkout with full history. `DOGFOOD_DEPTH=<n>` moves the base to `HEAD~<n>`.
- Open the `dogfood` job of the `ci` workflow on GitHub.

## Driving it with the CLI and the page API

Preconditions:

- The checkout has at least 7 commits of history (`git rev-list --count HEAD`). A shallow clone fails with `fetch full history`.
- Nothing needs to be exported. The script makes its own `FOLLOW_ME_HOME`, so it never touches a running server.
- Uncommitted changes are not part of the run. The script clones HEAD.

- **Whole flow.** Run `scripts/dogfood.sh`. Expect `== follow-me extract`, `plan --naive`, `check`, `apply --no-sign` headers in that order and exit code `0`.
- **Naive plan.** `plan --naive` prints `wrote .follow-me/dogfood/draft.json (<n> commits)`. `check` then lists `wip: <path>` lines, with `(mode)` or `(binary)` for whole-file units.
- **Syntax gate.** `check` prints `syntax: <n> writes checked, <m> files skipped (no checker for .md, ...)`. No `$.commits[` lines appear.
- **Proof.** The last two lines are `dogfood: ok, <n> commits on dogfood-split` and `proof: dogfood-split^{tree} <hash> equals dogfood^{tree} <hash>`. The hashes match.
- **Second view.** The script asserts `git status --porcelain` is empty in the clone and deletes it on exit. In your own checkout, `git status --porcelain` and `git branch --list "dogfood*"` show nothing new.
- **Failure.** `DOGFOOD_DEPTH=100000 scripts/dogfood.sh` exits `1` with `HEAD~100000 does not exist`.

## Gotchas

- The script runs the CLI from the checkout it lives in (it needs `node_modules`) but splits a clone, so the checkout's branches and `.follow-me/` stay untouched.
- `apply` runs with `--no-sign`, so a global `commit.gpgsign` cannot prompt for a key in CI or a terminal.
- The base moves with HEAD. A new commit that touches a file the gate cannot parse at the tip is reported as the tip's own state and does not fail the run.
- Do not run `plan` without `--naive` here. It calls the Anthropic API.
