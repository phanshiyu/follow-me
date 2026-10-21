# Split a branch

Split turns the checked-out branch's net change into story-ordered commits on `<branch>-split` and proves the last commit's tree equals the original tip's tree, without touching the original branch, index or working tree.

## Sub-features

- `split-extract` anchors a session and lists files and units.
- `split-check-error` reports every problem in a bad draft at once and exits 1.
- `split-check-ok` accepts a good draft and lists its commits.
- `split-apply` writes `feature-split` and prints the `proof:` line.
- `split-reapply` runs apply again and changes nothing.
- `split-status` reports plans, lock and the applied branch.

## How to get to it (user POV)

- Run `follow-me extract --base main`, then `check`, then `apply` from the repo with the branch checked out.
- Run `follow-me status` for the session summary.
- Run `follow-me prompt` to print the planner prompt. The agent writes `.follow-me/<branch>/draft.json`.

## Driving it with the CLI and the page API

Preconditions:

- `$A` is a fresh fixture, `FOLLOW_ME_HOME` is the throwaway dir, `RUN_ID` is set.
- `$A` has no `.follow-me/` yet.

- **Whole flow.** Run `.claude/skills/verify-follow-me/scripts/drive.sh "$A"`. It prints `<step>: exit <code>` for extract, check-planted, check, apply, apply-again and status, then the evidence path. Expect `0 1 0 0 0 0` in that order.
- **Extract.** `drive.sh` runs `follow-me extract --base main` in `$A`. Expect `feature <sha> onto main <sha>: 8 files, 9 units`, one line per file, and `session .follow-me/feature`.
- **Planted error.** It writes a draft that leaves the last unit out and runs `follow-me check`. Exit code is `1` and stdout is `h_<id>:0 (src/old-name.js) is in no commit` (the id and path can differ if the fixture changes).
- **Good draft.** It writes two commits covering every unit. `check` exits `0` and prints `ok: 2 commits, plan <hash>` with one line per commit.
- **Apply.** `apply` exits `0` and prints `created feature-split at <sha> from plan v1 (2 commits)` then `proof: feature-split^{tree} <hash> equals feature^{tree} <hash>`. The two hashes match.
- **Re-apply.** The second `apply` exits `0` and prints `unchanged feature-split at <same sha> from plan v1 (2 commits)` with the same proof line.
- **Second view.** `split-log.txt` shows `git log --oneline feature-split` as the two commits above `base`. `trees.txt` shows equal tree hashes. `fixture-status.txt` is empty. `status.out` ends with `applied: plan v1 as feature-split at <sha>`.
- **Proof.** All of the above are files in `.follow-me-verify/$RUN_ID/split/`. Read `apply.out` and `trees.txt` and compare the hashes yourself.
- **Refusal.** In `$A`, run `"$FM" apply --name feature --force`. Exit code `1`, and stderr says `feature is the branch being split`. `git -C "$A" rev-parse feature` is unchanged.

## Gotchas

- The fixture repo has `.follow-me/` ignored by its own `.gitignore`, so `git status --porcelain` stays empty even after a session exists.
- Unit ids are content hashes. Read them from `loadDiff` as `drive.sh` does. The ids in `follow-me prompt` examples (`h_0123456789ab`, `f_0123456789ab`, `h_ba9876543210`) are not real units.
- `plan` without `--naive` exits 1: there is no built-in planner. Write the draft yourself.
- Running `drive.sh` twice on one fixture reuses its session. Use a fresh fixture for a clean first-apply proof.
- Without `FOLLOW_ME_HOME` the script refuses to run. That guard exists to keep the real server out of the run.
