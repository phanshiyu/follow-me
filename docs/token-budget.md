# Token budget

What a coding agent reads from follow-me in one session, measured by
`node scripts/measure-tokens.ts` (add `--out <dir>` to keep each step's text). The script drives a
whole session without a model: the skill, the first `follow-me`, prompt.md, a draft and its check,
the launch, a batch with a comment on changed lines, a comment on a context line and a question, a
reply round (the agent's reply, a reviewer reply, an edited comment, a concern decision), one idle
call, a commit that edits one hunk with the re-plan prompt and the swap, and the final report.

It runs on two inputs. The fixture is `test/fixture-repo.ts`. The real branch is this repo's 20
commits up to `8acfcfc` (v0.4.1), pinned so every row below measures the same input. Its draft is
one commit per file, as `plan --naive` writes, so the check lists 53 commits.

Tokens are an estimate: bytes / 4. No tokenizer or API was called.

## Baseline (8acfcfc plus the script)

| step | fixture bytes | ~tokens | real branch bytes | ~tokens |
|---|---:|---:|---:|---:|
| skill | 3894 | 974 | 3894 | 974 |
| first follow-me | 251 | 63 | 242 | 61 |
| prompt.md | 6457 | 1614 | 226413 | 56603 |
| check | 505 | 126 | 3042 | 761 |
| launch | 409 | 102 | 401 | 100 |
| batch: 2 comments, 1 question | 838 | 210 | 2046 | 512 |
| reply | 51 | 13 | 51 | 13 |
| reply round | 478 | 120 | 759 | 190 |
| idle call | 75 | 19 | 75 | 19 |
| re-plan | 244 | 61 | 235 | 59 |
| re-plan prompt.md | 9655 | 2414 | 235800 | 58950 |
| swap | 569 | 142 | 562 | 141 |
| reply on changed thread | 51 | 13 | 51 | 13 |
| final report | 837 | 209 | 1368 | 342 |
| **total** | **24314** | **6079** | **474939** | **118735** |

The two prompts are 66% of the fixture session and 97% of the real one. The re-plan prompt sends
the whole unit dump again for a commit that changed one hunk, and quotes one comment twice.

## Cuts

Each row is the total after that commit, measured with the same script. Per-step numbers for the
final build are in the last table.

| cut | fixture bytes | ~tokens | real branch bytes | ~tokens | what moved |
|---|---:|---:|---:|---:|---|
| baseline | 24314 | 6079 | 474939 | 118735 | |
| a. rules into the skill, top-down order | 22765 | 5691 | 473388 | 118347 | skill 3894 to 12134 (read once); prompt.md 6457 to 1891 and re-plan prompt 9655 to 4432 on the fixture |
| b. re-plan prompt: bodies only for new units | 20308 | 5077 | 253628 | 63407 | re-plan prompt.md 4432 to 1975 (fixture) and 230575 to 10815 (real); unchanged units one line each, a comment quoted only when its hunk changed |
| c. event digest: refs for what the agent has, quotes capped | 19916 | 4979 | 252678 | 63170 | batch 838 to 729 and 2046 to 1660; reply round 478 to 290 and 759 to 290 (quotes cap at 6 rows of 160 characters; edits, replies, resolves and decisions are one line) |
| d. `follow-me show <ref>` | 20270 | 5068 | 253032 | 63258 | adds 354 bytes to the skill; every ref (h_, c_, k_, path:line@commit) now expands to the lines and thread as the split writes them, so the refs in b and c never cost a file read of the wrong version |
| e1. porting steps in their own file | 18914 | 4729 | 251676 | 62919 | skill 12488 to 11016; `porting.md` installs beside it and is read only when the user asks to post (first output gains one `wrote` line, once) |
| e2. trims the measurements showed | 18633 | 4658 | 247413 | 61853 | final report 746 to 489 and 1277 to 589 (comments that the report quotes are not also printed as events; the context-row rule lives in the skill); the unit dump drops the path repeated under each `### path` (prompt.md 221847 to 218202); `reply` and `explain` now say `next: run follow-me again; the reviewer is still working` instead of `follow-me watch` (+35 bytes each, kept on purpose) |
| f. commit sections | 20066 | 5017 | 250683 | 62671 | skill 11016 to 11255 (+239, read once) for the `section` lines; measured from `8e5ef70`, whose totals are 19827 and 250444 because the final report grew after e2 |

## Before and after, per step

Baseline is `6d7c562`, final is `cae6178`. Tokens are bytes / 4.

| step | fixture before | fixture after | real before | real after |
|---|---:|---:|---:|---:|
| skill (read once) | 3894 | 11016 | 3894 | 11016 |
| first follow-me | 251 | 367 | 242 | 358 |
| prompt.md | 6457 | 1797 | 226413 | 218202 |
| check | 505 | 505 | 3042 | 3042 |
| launch | 409 | 409 | 401 | 401 |
| batch: 2 comments, 1 question | 838 | 729 | 2046 | 1660 |
| reply | 51 | 86 | 51 | 86 |
| reply round | 478 | 286 | 759 | 286 |
| idle call | 75 | 75 | 75 | 75 |
| re-plan | 244 | 244 | 235 | 235 |
| re-plan prompt.md | 9655 | 1975 | 235800 | 10815 |
| swap | 569 | 569 | 562 | 562 |
| reply on changed thread | 51 | 86 | 51 | 86 |
| final report | 837 | 489 | 1368 | 589 |
| **total bytes** | **24314** | **18633** | **474939** | **247413** |
| **~tokens** | **6079** | **4658** | **118735** | **61853** |

The fixture session is 23% smaller and the real one 48% smaller. Each further re-plan saves about
7.7 KB on the fixture and 225 KB on the real branch, and each further prompt read saves about 4.6 KB.
The unit dump in the first prompt is what is left on a real branch: it is the code the agent has to
read to plan, so it stays.

Kept on purpose: the 3 to 6 row quote on a comment the agent has not seen; the `proof:` line and full
tree ids on apply; the `check` listing of commits (the bare loop never prints it, and people running
`check` by hand read it); the interactive reminder on every `next:` line while the page is open.

## Quality gate

Two blind runs, one per build, each by a separate sonnet subagent acting as the coding agent. Each
got only the skill text and an ordinary request: split my branch with follow-me in
`/tmp/ledger-a/calc` (or `-b`), answer the question I ask on the page, then stop. The repo was the
fixture, renamed. Each ran with its own `HOME` and `FOLLOW_ME_HOME`, a `follow-me` shim that logged
every call, and a no-op `open`. A script acting as the reviewer waited for the page and asked on the
`assertNumber(a);` line in `add`: "What does add('1', 2) do after this change, and where does that
come from?" Since the owner's change of scope, "tells a story" means "reads top-down", entry point
before the helpers it calls.

| | baseline `6d7c562` | final `cae6178` |
|---|---|---|
| valid draft | yes, first try, tree proof equal | yes, first try, tree proof equal |
| `follow-me` calls | 3 bare, 1 reply, 0 failed | 3 bare, 1 reply, 0 failed |
| fix rounds | 0 | 0 |
| tool calls (subagent's count) | 5 | 5 |
| commit order | guard module, add, mul, div, pow, rename, notes and mode, README and logo | rename, add and mul calls, div, pow, guard module, README, notes and logo, mode |
| top-down | no: the helper comes first, the rename sixth (it followed the old scaffolding-first rule) | yes: rename first, the callers before `assertNumber`, the mode change last |
| answer | correct: throws `TypeError: not a number` from `assertNumber` in `src/guard.js`; before, `"12"` | correct, same content |

The final build did not do worse on any measure, so nothing was put back. Neither run wrote a
`responses` entry or narration for the question; both answered with `follow-me reply`, as the skill
allows. Not covered by the gate: the re-plan after a commit (cut b) and `follow-me show` (cut d).
The CLI tests and the measuring script exercise those, but no blind agent did.
