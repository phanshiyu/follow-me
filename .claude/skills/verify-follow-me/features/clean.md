# Clean

Clean removes follow-me leftovers in a repo. It deletes sessions whose branch is gone, review drafts no review can resume, and files left by dead processes. `--all` removes `.follow-me/` entirely.

## Sub-features

- `clean-dry-run` lists what would go and removes nothing.
- `clean-orphan` removes the session of a deleted branch.
- `clean-keeps-live` leaves sessions whose branch exists.
- `clean-all` removes `.follow-me/`.

## How to get to it (user POV)

- Run `follow-me clean --dry-run`, then `follow-me clean`, in the repo.
- Run `follow-me clean --all` to start over.

## Driving it with the CLI and the page API

Preconditions:

- `$A` is a fresh fixture with a session. Run `.claude/skills/verify-follow-me/scripts/drive.sh "$A"` first. `mkdir -p "$EV/clean"`.

- **Keeps live.** In `$A`, run `"$FM" clean --dry-run` and `"$FM" clean`. Both exit `0` and print nothing. `.follow-me/feature/` is still there.
- **Orphan.** Run `git checkout -q main && git branch -q -D feature feature-split`. Then `"$FM" clean --dry-run` prints `.follow-me/feature` and `ls .follow-me/feature` still works.
- **Remove.** `"$FM" clean` prints `.follow-me/feature`. `ls .follow-me` shows only `.gitignore`.
- **All.** `"$FM" clean --all` prints `.follow-me` and exits `0`. `ls -a "$A"` has no `.follow-me`.
- **Proof.** Save each stdout, exit code and the `ls -a` listings under `$EV/clean/`.

## Gotchas

- `clean --all` refuses while a live process holds a session. End or stop the server first.
- Deleting `feature` also deletes the fixture's only branch with the change, so use a throwaway fixture.
- `clean` prints the paths it removed, relative to the cwd. An empty stdout means nothing needed cleaning.
- Plan versions stay after a plain `clean`. Reviews refer to them.
