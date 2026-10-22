---
name: follow-me
description: Review a branch with the user, hunk by hunk in a local page, and carry the review to the merge request. Use when the user asks to review, split, clean up or reorder a branch's commits, to read someone else's branch, or to post a follow-me review to GitLab or GitHub.
---
# follow-me
follow-me is interactive. After it launches the review page, keep running `follow-me` until it prints the report. Each run waits up to 90 seconds for the reviewer.
Do not stop, do not summarise, and do not ask the user whether to continue. The user is on the page.

The user never types a follow-me command. If `follow-me` is not on PATH, tell them to run `npm i -g @shiyuphan/follow-me`; otherwise you run everything. They use the page, press Submit, and ask you to post the review.
1. From the repo root run `follow-me`. It does the next missing thing, prints what happened, and ends with a `next:` line. Do what it says, then run `follow-me` again.
2. When it says to write `.follow-me/<slug>/draft.json` from `prompt.md`, read the prompt, write the draft as "Writing the draft" below says, and run `follow-me` (it checks the draft, prints every issue, and applies when valid).
3. When it prints the review page URL, tell the user once and keep running `follow-me`. Each call listens up to 90 seconds and prints what the user flagged or asked, with comment ids, the moment they post it.
4. Answer a question in place with `follow-me reply <id> --body "<markdown>" [--diagram file]` (Mermaid source for a picture). Start a thread yourself with `follow-me explain [--commit n] [--unit id] [--lines a-b] --body "..."`.
5. When the user asks for a code change, make it on the original branch and commit it there. Then run `follow-me`. It carries the plan over, asks you to place any new units in the draft, and swaps the open page to the new code with the thread kept. Then `follow-me reply <id>` on that comment saying what changed and where (file and line), and run `follow-me` again.
6. Repeat until it prints the report and `next: done`. Fix each issue in the code, or say why you decline. On someone else's branch you only report.
7. Never run `git rebase` or `reset` for this, and never touch the `-split` branch. The only commits you make are the requested fixes on the original branch.
8. To see code or a thread follow-me names by ref (`h_…`, `c_…`, `k_…`, `path:line`, `path:line@3` for commit 3, `path:line@base`), run `follow-me show <ref>` instead of reading files. A file in the working tree is the tip, not the commit the reviewer is reading.
## Writing the draft
prompt.md holds the session: the draft path, base and tip, the check command, the units, and the comments to answer. This section is how to write the draft from it. Commits are numbered from 1 everywhere.
Author mode ("plan the commits"): You are reordering a finished branch into a series of commits that a reader can follow as the author's thought process. The final tree is fixed. You only decide how its change lines are grouped and ordered.
Reviewer mode ("tell the story of this branch"): The reader is a reviewer meeting this branch for the first time. They will read it commit by commit and comment on the code itself. The final tree is fixed. You decide how its change lines are grouped and ordered, and why each step is there.
### Order: top-down
Order the commits top-down, like a newspaper: the top level says what happens, the lower levels say how. A reviewer checks the business logic and the sequence before the helpers, so a wrong architecture shows up before anyone reads edge cases.
1. Pure moves and renames first. They are noise that makes every later diff readable.
2. Then the entry point and the main flow, the what: the top-level function, handler, command or component the change exists for, even though it calls things that do not exist yet.
3. Then each step it calls, in the order it calls them.
4. Then helpers, utilities, formatting and edge cases, the how.
5. A test goes with the behaviour it pins, right after it.
6. Config, wiring and lockfiles last, unless the story needs them earlier.

Give each commit the `section` its rule puts it in, and the page groups them under it: `"story"` for 1 and 2, `"steps"` for 3, `"details"` for 4, `"wiring"` for 6. A test takes the section of the behaviour it pins. `section` is optional.

One idea per commit. Prefer many small commits over a few large ones. Split a new file by function across commits when the order needs it; units split per change line, so this is always possible. Commits do not need to compile or pass tests on their own, and a call to a function that does not exist yet still parses. The last commit must bring the tree to exactly the tip, which follows from covering every unit.

Write each commit message as a short imperative title, then a blank line and a body that says why. Put the why in the body first, before anything else. Keep the title to 50 characters or fewer; put detail in the body.
### Format
Write the plan as JSON to the draft path in prompt.md, with its base and tip. Write only the file, in this format:
```json
{
  "schema": "follow-me/plan@1",
  "base": "<base from prompt.md>",
  "tip": "<tip from prompt.md>",
  "commits": [
    { "message": "Parse tokens\n\nThe reader sees the loop before the token type.", "units": ["h_0123456789ab", "h_ba9876543210:0-3,7"] },
    {
      "message": "Add the Token type",
      "narration": "Tokens are read in one pass, so the loop never backtracks.",
      "units": [{ "unit": "h_ba9876543210", "narration": "The type is boring on purpose." }, "f_0123456789ab"]
    }
  ],
  "responses": [
    { "comment": "c_abc234", "status": "addressed", "note": "Split the hunk and moved it earlier." }
  ]
}
```
`narration` is optional on a commit and on a unit, and the page shows it as your note. A unit with a note is written as `{ "unit": "<ref>", "narration": "..." }` instead of the plain ref string.

`diagram` is optional on a commit and on a unit, written the same way: `{ "unit": "<ref>", "diagram": "..." }`. It is Mermaid source that the review page draws beside the code: a commit's diagram under its commit, a unit's under its hunk. Add one only where a picture says what the code and prose cannot: data flowing between modules, a state machine, a call graph, or the before and after shape of a structure. Most commits need none. The first line names the diagram type, for example `"diagram": "flowchart LR\n  parse --> validate --> apply"`. The note stays plain text even when a diagram is present.

`responses` is [] when there are no review comments. `status` is one of "addressed", "declined", "deferred" or, for a question, "answered", and `note` says what you did or why not. An "answered" response also carries `"at": { "commit": 3, "unit": "h_x" }`: the commit, counted from 1, and optionally the unit that holds the explanation.
### Rules
- A unit is "h_…" (a text hunk), "f_…" (a whole file) or "m_…" (a mode change).
- Change lines are shown as `[n]+ text` or `[n]- text`. Indented lines without a bracket are context and cannot be selected.
- "h_x:0-3,7" takes change lines 0, 1, 2, 3 and 7 of hunk h_x. Indices are the [n] shown in prompt.md.
- A bare "h_x" takes every change line of that hunk that no other commit claimed.
- Every change line must be used exactly once across all commits. Never repeat a line.
- Use the unit ids exactly as printed. Do not invent ids.
- "f_…" and "m_…" units are taken whole, never with a line list.
- Every commit needs a non-empty message and at least one unit.
- Keep every file syntactically whole in every commit: a function with its closing brace, a block with both ends, an import before or with its first use. Commits need not build or pass tests, but each file a commit writes must parse.
- Check your work with the check command in prompt.md and fix every issue it prints, syntax errors included.
### Notes in reviewer mode
Add a `narration` to a commit, or to a unit, only when it says something the commit message body does not. The page shows it as your note. A note is one plain paragraph on why, in plain text with no markdown. Say why, not what the lines already show. Leave it out when the body already says it.
### Concerns in reviewer mode
You are also a careful reviewer. Add a concern only for something you would raise in a pull request: a bug or unhandled case, a change with no test where one is expected, a name that misleads, or a risky change such as a migration, concurrency or security. Pin it to the change lines with `lines`. Say what goes wrong and when, in one or two sentences. Severity: `blocker` breaks behaviour or loses data, `major` should be fixed before merge, `minor` is worth a note. Do not flag style, formatting or taste. Do not repeat the note. Most commits deserve no concern, and a plan with none is fine. Never write more than one concern per unit. Concerns are in your voice as a reviewer, while the note stays the author's.

A concern is `{ "severity": "blocker" | "major" | "minor", "kind": "bug" | "missing-test" | "naming" | "risk", "text": "...", "lines": [0, 1] }`. `lines` holds change indices of that unit and is allowed only on a unit ref. Write `"concerns": [ ... ]` on a commit, or on a unit written as an object: `{ "unit": "h_x:0-3", "concerns": [ ... ] }`. Never write an id; follow-me derives one.
### Comments and questions
Answer every comment and question prompt.md lists with one entry in `responses`, changing the plan where you agree.

A question is not a request to change the plan. Answer it by explaining, not by moving lines. Where the asked-about lines now live, add or rewrite the `narration` (the page shows it as your note) of that commit or unit so it answers the question, in plain sentences. When the answer is about flow, structure or order across files, add a `diagram` there too. Then write one response with `"status": "answered"`, a `note` of one to three sentences that answers the question directly, and `"at"` naming the commit (1-based) and unit that carry the explanation. Move lines only if answering shows the order itself was wrong. Say so in the note, and answer the question as well. If the diff cannot answer it, use `"deferred"` and say what is missing.

A comment on a context row (marked `>` with no + or -) is about code this branch leaves alone or depends on. The plan cannot move it, so do not move lines because of it. Answer a question with an explanation, or point at the commit that last touched those lines. Answer a change request as a code issue, not by reordering.
### When the branch moved
prompt.md then starts with what changed since the last plan. The draft already holds that plan on the new tip: every unit whose hunk did not change keeps its commit, and any commit left with no unit was dropped. Put each new unit into a commit, an existing one or a new one, and keep the rest as it is. Unchanged units are listed one line each; `follow-me show <id>` prints one in full. For each comment on a hunk that changed, write a response saying what you changed, and post the same with `follow-me reply <id>`.
## Porting a review
Only when the user asks to post the review: read `porting.md` beside this file and follow it.
