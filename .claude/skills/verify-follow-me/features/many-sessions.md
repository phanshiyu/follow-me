# Many sessions

One review server per user hosts every session across repos. A second `review` or `walk` registers with the running server and prints another URL, and the server exits once the last session ends and the idle window passes.

## Sub-features

- `many-two-sessions` hosts two fixtures on one server, one review and one walk.
- `many-index` lists both on the index page and in `/api/sessions`.
- `many-same-url` returns the same URL when the same session is started again.
- `many-isolated` keeps comments and endings per session.
- `many-exit` exits the server after both sessions end.

## How to get to it (user POV)

- Run `follow-me review` in one repo and `follow-me walk` in another while the first is open.
- Open `http://127.0.0.1:<port>/` and pick a session from the list.
- Run `follow-me server status` or `follow-me server stop`.

## Driving it with the CLI and the page API

Preconditions:

- Two fixtures `$A` and `$B` (see Launch), each with a frozen plan from `drive.sh`. Run `drive.sh` once per fixture. `mkdir -p "$EV/many-sessions"`.
- `"$FM" server status` says `no server running`.

- **First session.** In `$A`, run `"$FM" review --no-open --detach`. It prints `follow-me review: http://127.0.0.1:<port>/s/<idA>/`.
- **Second session.** In `$B`, run `"$FM" walk --no-open --detach`. It prints `follow-me code review:` with the same port and a different id. No second server starts.
- **Status.** `"$FM" server status | tee "$EV/many-sessions/status.txt"` shows one pid and two session lines, one `review` and one `walk`, each with its repo path.
- **Same URL.** In `$A`, run `"$FM" review --no-open` again. It prints the same URL as before and exits `0`.
- **Index.** `curl -s -H "$H" "http://127.0.0.1:<port>/" | grep -oE 'href="/s/[0-9a-f]+/"'` prints both ids. `curl -s -H "$H" http://127.0.0.1:<port>/api/sessions` returns a JSON array of two objects with `branch`, `mode`, `version`, `comments` and `repo`.
- **Isolation.** Post one comment to session A only. `/api/sessions` shows `comments` 1 for A and 0 for B.
- **End both.** Post `api/end` to each session. After the first, `server status` still lists the other. After the second it says `no sessions`.
- **Exit.** Wait two seconds (`FOLLOW_ME_IDLE_MS=1000`). `"$FM" server status` prints `no server running` and `$FOLLOW_ME_HOME/server.json` is gone.
- **Reviews.** `$A/.follow-me/feature/reviews/v1.json` has `"mode": "split"` and one comment. `$B/.follow-me/feature/reviews/v1.json` has `"mode": "walk"` and none.

## Gotchas

- Both fixtures live in the same temp dir parent, and their session ids hash the session directory, so ids differ per fixture and per run.
- If the first foreground command is the server, ending its own session does not stop the server while others are hosted. It prints `still serving 1 other session`.
- `server stop` before the sessions end releases their locks and writes no review. Autosaved drafts stay.
- Use `--detach` for every command here, or the shell blocks on the first one.
- Never point this at the user's real `FOLLOW_ME_HOME`. Doctor must say `isolated`.
