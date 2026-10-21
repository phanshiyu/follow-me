---
name: follow-me
description: Review a branch with the user, hunk by hunk in a local page, and carry the review to the merge request. Use when the user asks to review, split, clean up or reorder a branch's commits, to read someone else's branch, or to post a follow-me review to GitLab or GitHub.
---
# follow-me
The user never types a follow-me command. If `follow-me` is not on PATH, tell them to run `npm i -g @shiyuphan/follow-me`; otherwise you run everything. They use the page, press Submit, and ask you to post the review.
1. From the repo root run `follow-me`. It does the next missing thing, prints what happened, and ends with a `next:` line. Do what it says, then run `follow-me` again.
2. When it says to write `.follow-me/<slug>/draft.json` from `prompt.md`, read the prompt, write the draft, and run `follow-me` (it checks the draft, prints every issue, and applies when valid). Put the why in each commit body.
3. When it prints the review page URL, tell the user and keep running `follow-me`: each call listens up to 60 seconds and prints what the user flagged or asked, with comment ids.
4. Answer a question in place with `follow-me reply <id> --body "<markdown>" [--diagram file]` (Mermaid source for a picture). Start a thread yourself with `follow-me explain [--commit n] [--unit id] [--lines a-b] --body "..."`. Flags the user is still collecting stay hidden from you until they press Submit.
5. Repeat until it prints the report and `next: done`. Fix each issue in the code, or say why you decline. On someone else's branch you only report.
6. Never run `git rebase`, `reset` or `commit` for this. The draft is the only file you write.
## Porting a review
Only when the user asks to post it.
1. `follow-me report --json` prints items with `path`, `oldPath`, `newLine`, `oldLine`, `startNewLine`, `startOldLine`, `severity`, `kind`, `body` (markdown, ready to post), `thread`, `resolved`, `excluded`. Skip `excluded: true`. Lines are the branch tip's, or the base's for a removed line. Tell the user the count and first lines, ask which merge request or pull request, and never post without a yes.
2. Fetch the target with `glab mr view <iid> --output json` (`diff_refs`) or `gh pr view <n> --json headRefOid,baseRefName`. Its head must equal the tip on the first line of `follow-me status`; if not, say so and stop, because the line numbers would be wrong.
3. GitHub: post one review with `gh api repos/{owner}/{repo}/pulls/<n>/reviews --input review.json`, `"event": "COMMENT"`, each item in `comments[]` as `path`, `body`, and `line`+`side` (`newLine` with `RIGHT`, or `oldLine` with `LEFT`), plus `start_line` and `start_side` for a range; items without `path` go in the review `body`. Never APPROVE or REQUEST_CHANGES unless asked.
4. GitLab: one discussion per item with `glab api --method POST projects/:id/merge_requests/<iid>/discussions` and `position[position_type]=text`, `base_sha`, `start_sha`, `head_sha` from `diff_refs`, and `new_path`, `old_path`, `new_line` (added), `old_line` (removed) or both (context) from the item. Items without `path`: `glab mr note`.
5. Report what was posted with links and what failed; do not retry blindly. follow-me never holds a token; `gh` and `glab` do, and you run them.
