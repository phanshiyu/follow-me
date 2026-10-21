# Walk a branch

Walk is the reviewer's mode. It plays a narrated plan of someone else's branch commit by commit, lets the reviewer comment on the code, and saves a code review for the author. Nothing is applied and no branch is written.

## Sub-features

- `walk-no-plan` prints the two commands to run when no plan exists.
- `walk-narrated-plan` accepts a draft whose commits and units carry narration.
- `walk-serve` hosts the plan in walk mode and exposes the narration in the page state.
- `walk-comment` records a hunk comment in a walk review.
- `walk-feedback` renders the saved review as a code review grouped by file.
- `walk-prompt` prints the reviewer's planner prompt.

## How to get to it (user POV)

- Run `follow-me walk --base main` on the branch under review.
- Run `follow-me prompt --walk` to get the prompt a coding agent follows to write the narrated plan.
- In the page, use "Play" to start, "Comment" on a line, and "Finish code review".

## Driving it with the CLI and the page API

Preconditions:

- `$A` is a fresh fixture with no `.follow-me/` yet, `FOLLOW_ME_HOME` is the throwaway dir. `mkdir -p "$EV/walk"`.

- **No plan.** In `$A`, run `"$FM" extract --base main`, then `"$FM" walk --no-open`. Exit code `1`, stdout begins `no plan for feature yet` and ends with `follow-me prompt --walk` and `follow-me walk`.
- **Prompt.** Run `"$FM" prompt --walk | head -3`. It starts `# follow-me: tell the story of this branch`.
- **Narrated draft.** Write the draft with the node one-liner below, then run `"$FM" check`. Expect `ok: 1 commit, plan <hash>`.

  ```sh
  FIXTURE=$A ROOT=$PWD node --input-type=module -e '
    const { loadDiff } = await import(process.env.ROOT + "/src/git.ts");
    const { writeFileSync } = await import("node:fs");
    const diff = await loadDiff(process.env.FIXTURE, "main", "feature");
    const units = [...diff.units.keys()];
    const commits = [{ message: "feat: the whole change", narration: "First I read the whole change.",
      units: units.map((unit, i) => (i === 0 ? { unit, narration: "Start with this one." } : unit)) }];
    writeFileSync(process.env.FIXTURE + "/.follow-me/feature/draft.json",
      JSON.stringify({ schema: "follow-me/plan@1", base: diff.base, tip: diff.tip, commits, responses: [] }));
  '
  ```

- **Serve.** Run `"$FM" walk --no-open --detach`. Exit code `0`, stdout `follow-me code review: http://127.0.0.1:<port>/s/<id>/`. `"$FM" server status` shows `feature walk of plan v1`.
- **State.** `curl -s -H "$H" "${U}api/state" | tee "$EV/walk/state.json"`. `mode` is `walk`, `commits[0].narration` is `First I read the whole change.`, and `commits[0].refs[0].narration` is `Start with this one.`.
- **Comment.** Post a hunk comment for the README unit as in the review feature, with a body such as `Nit on intro.`. Expect 201.
- **Finish.** `curl -s -w ' [%{http_code}]\n' -H "$H" -X POST "${U}api/end"` answers 200. `reviews/v1.json` has `"mode": "walk"`.
- **Code review.** `"$FM" feedback | tee "$EV/walk/feedback.md"` starts `# Code review`, then `A reviewer watched this branch being written commit by commit and left 1 comment.`, then `## README.md` with the quoted diff and the comment text. With no comment it prints `The reviewer left no comments.`.

## Gotchas

- `walk` without a plan stops after printing instructions. It never calls a model.
- A walk review is a code review for the author. It does not feed the next split plan as comments to answer.
- A draft with no narration still walks. The narration check needs the fields above.
- Speech is the browser's built-in synthesis. The API run cannot hear it, so narration is verified as text in `state.json`.
- A moved branch is re-extracted by `walk` with a line `feature moved, re-extracted at <sha>`.
