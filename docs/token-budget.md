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
