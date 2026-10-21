# follow-me verification map

This directory is the maintained source for verifying the user-facing behavior of follow-me. Read the index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Run from the repo root with Node 24 or newer. There is no build step.
- Follow Launch in `../SKILL.md`. It creates `.follow-me-verify/<run-id>/env.sh` with `RUN_ID`, `EV`, `FOLLOW_ME_HOME` (a throwaway dir), `FOLLOW_ME_IDLE_MS`, `FM` (the CLI path) and `A` (a fixture repo).
- Source the env file at the start of every tool call. Shell state does not persist.
- Run `"$FM" server status` and the Doctor checks. Require `isolated` and `no server running` before the first drive.
- Never drive a server that this run did not start.
- Create `$EV/<feature-id>/` before capture.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise. A recipe that mutates `$A` says so, and a fresh fixture resets it.
- The surface is the CLI plus the review page's JSON API. Use `"$FM" <command>` from inside the fixture, with `--no-open` on `review` and `walk`.
- Send every `curl` with `-H "Origin: http://127.0.0.1:<port>"`. Read the port and session URL from `"$FM" server status`.
- With a browser, prefer roles and accessible names ("Play", "End review", "Comment", "Comment on the message", "This belongs elsewhere") and `nav[aria-label=Commits]`.
- Treat every command as literal. Keep flags and quoted values unchanged.
- Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final output.
- CLI proof includes the command, stdout, stderr, and exit code.
- Mutation proof includes a read-only second view, such as `git log`, `git status --porcelain`, `follow-me status`, or the review JSON file.
- Record the feature ID and entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report the page UI as verified when only its JSON API was driven. Say "API only".

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with the CLI and the page API` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Split a branch](./split.md) covers extract, check with a planted error, apply with the tree proof, and idempotent re-apply. `../scripts/drive.sh` runs it.
- [Review a split](./review.md) covers starting the server, commenting through the API, ending, and feedback.
- [Walk a branch](./walk.md) covers the narrated plan, walk mode, and the code review output.
- [Many sessions](./many-sessions.md) covers two fixtures on one server, the index page, and the server exiting when both end.
- [Install and uninstall the agent skill](./install-uninstall.md) covers detection, install, an unchanged rerun, and uninstall in a temp HOME.
- [Clean](./clean.md) covers removing sessions of deleted branches and `clean --all`.
- [Dogfood](./dogfood.md) covers `scripts/dogfood.sh`: the naive planner, the syntax gate and the tree proof on this repo's own last commits.
