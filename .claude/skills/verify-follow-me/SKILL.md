---
name: verify-follow-me
description: Drive the real follow-me app (a git branch splitter CLI plus the local web review page its per-user server hosts) against a disposable fixture repo and capture proof. Reach for it to confirm a change to src/, ui/ or skills/ works in the real binary, not just in tests.
---

# Verify follow-me

follow-me splits a branch into story-ordered commits and serves a review page on `127.0.0.1`. The primary surface is the CLI (`node bin/follow-me.ts <command>`, Node 24+, no build). The second surface is the review page, served by one per-user server and driven here through its JSON API. Run everything from the repo root. Read `features/README.md` first, then the feature file for what you changed.

## Launch

Shell state does not persist between tool calls, so the launch step writes an env file and every later call sources it. The env file points `FOLLOW_ME_HOME` at a throwaway dir. Without it the run would attach to the user's real review server.

```sh
RUN_ID=$(date +%Y%m%d-%H%M%S); EV=$PWD/.follow-me-verify/$RUN_ID; mkdir -p "$EV"
cat > "$EV/env.sh" <<EOF
export RUN_ID=$RUN_ID
export EV=$EV
export FOLLOW_ME_HOME=$(mktemp -d "${TMPDIR:-/tmp}/follow-me-home.XXXXXX")
export FOLLOW_ME_IDLE_MS=1000
export FM=$PWD/bin/follow-me.ts
export A=$(.claude/skills/verify-follow-me/scripts/fixture.sh)
EOF
. "$EV/env.sh"
```

Start each later call with `. <repo>/.follow-me-verify/<run-id>/env.sh`. The many-sessions feature needs a second fixture. Append `export B=$(.claude/skills/verify-follow-me/scripts/fixture.sh)` to the env file and source it again.

- `$A` is a git repo with `main` and a checked-out `feature` branch covering every change kind (multi-hunk edit, new, deleted, binary, mode change, no trailing newline, rename). It lives under `$TMPDIR` as `follow-me-fixture-*`.
- `fixture.sh` wraps `makeFixtureRepo()` from `test/fixture-repo.ts`. It prints the path and nothing else.
- Run the CLI as `"$FM" <command>` from inside the fixture. `bin/follow-me.ts` is executable, so this works in zsh and bash.
- `FOLLOW_ME_IDLE_MS=1000` makes the server exit 1s after its last session ends instead of 30s.
- Split work needs no server. For the review page, `"$FM" review --no-open --detach` starts the server in the background and returns only once it answers. It prints `follow-me review: http://127.0.0.1:<port>/s/<id>/`. Without `--detach` the command is the server and blocks until the review ends. Run it in the background and wait for that same line on stdout.
- The server binds `127.0.0.1` on a free port. Pass `--port <n>` only when a feature needs a known port.
- Always pass `--no-open`, or the command opens a browser.

## Browser setup

There is no `agent-browser` in this checkout. The default drive path is the page's JSON API, shown under Drive. A run that has a browser (Computer Use, a Playwright driver) opens the session URL that `review` or `walk` printed, `http://127.0.0.1:<port>/s/<id>/`, or the index at `http://127.0.0.1:<port>/`. Take a fresh snapshot after every action. Stable handles, taken from `ui/`:

- Buttons named "Play", "End review" ("Finish code review" in walk mode), "Comment", "Comment on the message", "This belongs elsewhere".
- The commit list `nav[aria-label=Commits]`, and `nav[aria-label=Sessions]` on the session page.

Serialize access to the desktop if you share it. Close only the tab you opened. A browser run still verifies side effects with the files and API calls under Evidence.

## Doctor

Read-only. Run it first, and again whenever anything looks off.

```sh
. "$EV/env.sh"
node -v                             # 24 or newer
case "$FOLLOW_ME_HOME" in */follow-me-home.*) echo isolated;; *) echo "NOT ISOLATED, stop";; esac
"$FM" server status                 # "no server running", or pid, URL and the hosted sessions
git -C "$A" branch --show-current   # feature
```

When a server is up, also check it is ours. The pid in `server status` must equal the pid in `curl -s http://127.0.0.1:<port>/api/health`, which answers `{"app":"follow-me","pid":<n>}`. If `FOLLOW_ME_HOME` is not the throwaway dir, do not drive. Refusing beats corrupting the user's session.

## Drive

Split flow, scripted. It runs extract, a check with a planted error, a good check, apply and a second apply, and writes the evidence.

```sh
.claude/skills/verify-follow-me/scripts/drive.sh "$A"     # needs FOLLOW_ME_HOME and RUN_ID from env.sh
```

Everything else is driven by hand, one feature file each. The page API lives under `http://127.0.0.1:<port>/s/<id>/`. Send every call with `-H "Origin: http://127.0.0.1:<port>"`. Any other origin gets 403 `bad origin`.

| Call | Meaning |
| --- | --- |
| `GET api/state` | mode, anchor, plan version and hash, commits with refs and narration, comments |
| `POST api/comments` (JSON) | adds a comment, answers 201 `{"id":"c_xxxxxx"}` |
| `PUT api/comments/<id>` | replaces a comment, `DELETE` removes it |
| `POST api/end` | writes `reviews/vN.json`, releases the lock, answers `{"saved": path}` |

Server-wide: `GET /api/health`, `GET /api/sessions` (JSON list), `GET /` (HTML index).

A hunk comment body is `{"anchor":{"kind":"hunk","commit":0,"unit":"<h_ id from api/state>","changes":null},"context":{"commitMessage":"<that commit's message>","path":"<file>"},"body":"..."}`. A message comment uses `{"kind":"message","commit":1}` with `"path":null`. The server mints `id` and `createdAt`.

## Evidence

Everything goes to `.follow-me-verify/<run-id>/<feature>/` under the repo root. The directory is gitignored. Capture:

- Per CLI call, the command, stdout, stderr and exit code. `drive.sh` writes `<step>.cmd`, `.out`, `.err` and `.code`.
- The `proof: feature-split^{tree} <hash> equals feature^{tree} <hash>` line from `apply`, plus `git rev-parse` of both trees.
- `git -C "$A" log --oneline feature-split`, and `git -C "$A" status --porcelain`. Empty means the user's tree was untouched.
- Review JSON at `$A/.follow-me/feature/reviews/v1.json`, and the `"$FM" feedback` output.
- API responses with the HTTP status, for example `curl -s -w ' [%{http_code}]\n' ... | tee -a "$EV/<feature>/api.txt"`.

Proof standards. Exercise the real path, the CLI or the page API, never a test-only setter or a hand-edited session file. Capture the action and the state after it. Verify side effects (refs, files, the lock, the server record) beside the visible output. `--dry-run` and `--no-open` skip what their names say, and you confirm that by looking, for example that `install --dry-run` leaves no file. Nothing here mocks git or the network. `plan` calls the Anthropic API, so this skill never runs it. Write the draft by hand, as `drive.sh` does.

## Cleanup

Removes what the run created. Never kill by process name.

```sh
. "$EV/env.sh"
"$FM" server stop                # stops only the server recorded in $FOLLOW_ME_HOME
"$FM" server status              # expect: no server running
rm -rf "${A:?}" "${B:-}" "${FOLLOW_ME_HOME:?}"
ls "$TMPDIR" | grep follow-me    # expect: no output
```

Leave `.follow-me-verify/<run-id>/`. It is the proof. A failed attempt gets the same cleanup before the next try.

## Helpers

- `scripts/fixture.sh` prints the path of a fresh fixture repo. Usage: `A=$(.claude/skills/verify-follow-me/scripts/fixture.sh)`. Remove it with `rm -rf`.
- `scripts/drive.sh <fixture-dir>` runs the split flow and writes `.follow-me-verify/$RUN_ID/split/`. It exits non-zero if `FOLLOW_ME_HOME` or `RUN_ID` is unset.

## Isolation

One server runs per `FOLLOW_ME_HOME`, so runs with different homes never share a server. Two runs on one home share it. Do not double-drive a server you did not start.
