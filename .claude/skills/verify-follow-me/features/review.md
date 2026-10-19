# Review a split

Review serves the latest plan on a local page where a reviewer walks the commits, comments on a hunk or a commit message, and ends the review. Ending saves `reviews/vN.json`, and `feedback` hands the comments back to an agent as markdown.

## Sub-features

- `review-start` hosts the session on the per-user server and prints its URL.
- `review-state` serves the plan's commits and comments through the page API.
- `review-comment` adds a hunk comment and a commit-message comment.
- `review-origin` refuses a cross-origin write.
- `review-end` saves the review, releases the lock and lets the server exit.
- `review-feedback` prints the comments as markdown.

## How to get to it (user POV)

- Run `follow-me review` in a repo with an applied or checked plan, then open the printed URL.
- In the page, use "Comment" on a hunk, "Comment on the message" on a commit message, and "End review".
- Run `follow-me feedback` after the review ends.

## Driving it with the CLI and the page API

Preconditions:

- `$A` has a frozen plan. Run `.claude/skills/verify-follow-me/scripts/drive.sh "$A"` first.
- `"$FM" server status` says `no server running`. `mkdir -p "$EV/review"`.

- **Start.** In `$A`, run `"$FM" review --no-open --detach`. Exit code `0`, stdout `follow-me review: http://127.0.0.1:<port>/s/<id>/`. `"$FM" status` shows `lock: held by pid <n> (follow-me review)` and the same `review page:` URL.
- **Doctor.** `"$FM" server status` lists `feature review of plan v1, 0 comments`. `curl -s http://127.0.0.1:<port>/api/health` answers the same pid.
- **State.** Set `U` to the session URL and `H="Origin: http://127.0.0.1:<port>"`. Run `curl -s -H "$H" "${U}api/state" | tee "$EV/review/state.json"`. `mode` is `split`, `commits` has two entries, and each ref has a `unit` id.
- **Hunk comment.** Take a unit id from `state.json`, such as the first `commits[0].refs[0].unit`. Run `curl -s -w ' [%{http_code}]\n' -H "$H" -H 'content-type: application/json' -d '{"anchor":{"kind":"hunk","commit":0,"unit":"<id>","changes":null},"context":{"commitMessage":"feat: first half of the change","path":"README.md"},"body":"Why is the intro rewritten here?"}' "${U}api/comments"`. Expect `{"id":"c_......"} [201]`.
- **Message comment.** Post `{"anchor":{"kind":"message","commit":1},"context":{"commitMessage":"feat: second half of the change","path":null},"body":"Vague subject."}` the same way. Expect 201. `"$FM" server status` now says `2 comments`.
- **Cross-origin.** Post any body with `-H "Origin: http://evil.example"`. Expect `{"error":"bad origin"} [403]` and the comment count unchanged.
- **End.** Run `curl -s -w ' [%{http_code}]\n' -H "$H" -X POST "${U}api/end"`. Expect `{"saved":".../.follow-me/feature/reviews/v1.json"} [200]`.
- **Saved review.** `$A/.follow-me/feature/reviews/v1.json` exists, has `"schema": "follow-me/review@1"`, `"mode": "split"` and two comments. `v1.draft.json` is gone. `"$FM" status` shows `lock: free` and `reviews: v1 (latest has 2 comments, 2 open)`.
- **Feedback.** Run `"$FM" feedback | tee "$EV/review/feedback.md"`. Exit code `0`. It starts `# Review of plan v1`, lists each comment id under its commit, and ends with the instruction to answer every id in `responses`.
- **Server exit.** Wait 2s. `"$FM" server status` prints `no server running`.

## Gotchas

- Running `review` a second time on a plan that already has a review fails with `plan v1 already has a review`. Use a fresh fixture, or change the plan.
- `review` needs a valid plan. Without a draft or frozen plan it refuses.
- Without `--detach` the command is the server and blocks until the review ends, so a foreground run needs a background shell.
- The comment `unit` must match `h_` or `f_` or `m_` plus twelve hex characters. A made-up id gets 400, not a saved comment.
- Ending is final. The session leaves the registry, so later calls to its `api/` paths fail instead of editing the saved review.
- API only is not the page. Say so unless a browser drove "Comment" and "End review".
