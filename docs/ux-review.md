# follow-me UX review

Reviewed on 2026-10-19 against the working tree. I built the fixture from `test/fixture-repo.ts` and ran `extract`, `prompt`, `check`, `apply`, `review --detach --no-open --port 4760`, `feedback`, `status`, `walk` and `server stop`. The plan had eight commits, with `h_7da8387be1bf` split `:0-1`, `:2`, `:3-6` and a two-sentence first-person narration on every commit. The `preview_open` and `preview_snapshot` tools worked, but `preview_click`, `preview_press` and `preview_evaluate` failed with "The calling provider no longer owns an active thread run". So I drove the same page in headless Chrome over the DevTools protocol. A MutationObserver logged every caption change, every change of current line and every `speechSynthesis.speak` call with timestamps. I pressed Play, paused with Space, commented on the line pause had selected, stepped with `n`, switched to dark mode, tabbed through the page, opened the index page and ended the review. Screenshots from that run are in `/tmp/fm-ux/` (p1 to p4 playback, q1 to q4 pause and comment, d2 dark, t1 focus, idx index, done end screen).

The two pstack principles framed the review. Experience first means the target is a reviewer who understands the branch, even when getting there costs more code. Exhaust the design space means playback has no prior art in this codebase, so it gets three different designs before one is picked.

## 1. The headline: playback is too fast and doesn't make sense

### What happens today

Here is the measured timeline at 1x. Each commit's narration is about 25 to 30 words, which takes about 10 seconds to speak.

```
   114ms  SPEAK + CAPTION "I start by moving the legacy flag..."   Commit 1
  1172ms  line old-name.js 0-       1650ms  line new-name.js 0+
  1905ms  SPEAK + CAPTION "Before touching the math..."            Commit 2
  3722ms  Commit 3 ... 6679ms Commit 4 ... 8004ms Commit 5
 10073ms  Commit 6 (mode change, no lines)   11128ms Commit 7 (binary, no lines)
 12186ms  Commit 8 ... 15608ms "That is the whole plan."
```

The whole eight-commit branch plays in 15.6 seconds. Two sentences of narration stay on screen for 1.0 to 1.8 seconds. These causes are in the code, in order of impact:

1. Commit narration is not waited for. `perform()` calls `speak(step.say)` for a commit step and then sleeps only `COMMIT_BEAT_MS` (700ms). Only unit narration uses `speakAndWait`. Lines therefore start typing while the narration still has eight seconds to run.
2. Speech queues and never catches up. `speechSynthesis.speak` adds to a queue, and nothing calls `cancel()` except a seek. With real speech, commit 2's narration is still waiting behind commit 1's when the screen already shows commit 4. By the end the audio is about a minute behind the picture, so the voice describes code that is no longer on screen.
3. The finished commit is never shown. The last line of a commit is current for 250ms, and then the next commit step re-renders the page and scrolls to the top. The reviewer never sees the result of a commit with all its lines together.
4. Single lines are the wrong unit of motion. Four lines per second is a typing effect, not reading speed. `assertNumber(a);` and `assertNumber(b);` arrive 250ms apart, too fast to read and too slow to feel instant.
5. Removals vanish. A `-` line fades to `max-height: 0`. In p4 the README hunk ends with no trace of `old intro`, so what the reviewer is left with is the new file, not a diff of what changed.
6. Units with no lines get about one second. Commits 6 and 7 (mode change and binary) produce a commit step and a unit step but no line steps, so they flash by.
7. Nothing on screen says where you are inside a commit. You get "Commit 3 of 8" and an outline that moves. Pausing (q1) leaves the second hunk with its future lines hidden by `display: none`. `mul` shows no guard, and nothing says two more lines are coming.
8. The narration sits in the wrong place. It is an italic caption squeezed into the right end of the control bar. It wraps to two lines and pushes the page down. When Play becomes Pause the button changes width, and every other control shifts by 12px.
9. Previous and Next only move between commits, and they leave the caption empty (q4) until Play is pressed again.

The owner's complaint is right, and the cause is structural, not a tuning constant. The script interleaves an unawaited voice with a fixed-rate typewriter, so no speed setting can make the two agree.

### What a reviewer needs at each moment

- Where: commit N of M and its title, the file, and which chunk of the commit (k of K). Overall progress is shown as a bar.
- Why: the narration, readable in full and placed next to the code it explains. It stays up for as long as it takes to read or hear.
- What: the chunk's change, shown as a whole block with its context. Removed lines stay visible and struck through.
- What's coming: upcoming chunks of this commit appear as collapsed placeholders, never as missing code.
- Time: reading speed, not animation speed, sets the pace. A pause comes at every chunk and a longer one at every commit boundary.

### What "a chunk" is

Three candidates:

- A hunk (unit ref). This matches the data model, but a whole-file hunk can run to 80 lines, and the split hunk in the fixture spans three commits.
- A single change line. This is what exists today and it is too granular.
- A run (recommended). A run is a stretch of the commit's own change lines inside one ref, with at most 3 context lines between them. A run longer than 12 change lines is split at the first blank or closing-brace line after 8 lines. `f_` and `m_` units are one chunk each. In the fixture this gives commit 3 two chunks (the import plus `add`, then `mul`), commit 5 one chunk (`pow`), and commit 8 two chunks (README, notes).

The planner already writes unit narration. Unit narration attaches to the first chunk of its ref. Later chunks of the same ref get no narration of their own.

### Three playback designs

Design A, Narrated typewriter (repair what exists). Keep line-by-line typing, wait for every utterance, cancel the queue on each new utterance, slow typing to reading speed, and add an end-of-commit hold. This is the smallest change and it keeps the "watch it being written" metaphor from the README. Its weakness is that the eye still has to chase a moving line, and reading code one line at a time breaks up statements. It also still has no clear "now" to comment on.

Design B, Chunk stepper (narration first, then the change). Each chunk is a beat. The narration card appears first and is spoken. Then the chunk's lines appear together as a block with a short fade, they stay highlighted for a dwell based on their length, and the next beat follows. It reads like a slide deck: say why, show what, rest. Comments attach to the current beat. It has a clear rhythm and a clear "now". The cost is that during narration the reader is looking at code that has not appeared yet, which can feel like waiting.

Design C, Spotlight over the finished commit (the change highlighted while the narration plays). The whole commit is shown at once, the way browse shows it, but dimmed. A spotlight walks from chunk to chunk, brightening and outlining the current one while its narration plays. Nothing types in. The reviewer always has the whole commit as context and can read ahead. It drops the "being written" feel, and in a long commit the reader may read ahead and ignore the voice.

How they compare on the things the owner asked about:

- Comprehension. A is weakest because statements arrive in fragments. B is strong. C is strongest for context but weakest for focus.
- Narration sync. In A the narration overlaps typing. In B the narration comes before the change it explains. In C it plays on top of the highlighted change.
- Pacing control. A has one knob. B and C have a natural unit (the beat), so "next chunk" means something.
- The product's identity. A keeps "watch it being written". B keeps it at chunk level. C turns playback into a guided tour.
- Effort. A is S to M. B is M: a new script shape in `playback.js`, a new stage UI, and the same tests rewritten. C is M and similar to B.

### Recommendation: Design B with C's context rules

Build the chunk stepper. Borrow one thing from C: chunks already presented in this commit stay fully visible, and upcoming chunks show as one-line placeholders, so the reader never sees a hunk with silent holes.

#### Script

`buildScript` returns beats instead of steps:

```
{ kind: "intro",  commit, say, words }                       // one per commit
{ kind: "chunk",  commit, unit, lines: number[], say|null }  // one per run, f_/m_ unit
{ kind: "outro",  commit }                                   // one per commit
```

`lineStates(script, position, commit)` keeps its pure, seekable contract. A line is `hidden` before its chunk, `shown` from its chunk on, and `struck` for a `-` line from its chunk on. `struck` replaces `gone`. It also returns `placeholder` counts for upcoming chunks.

#### States

- `ready`: the page is loaded and shows the intro card for commit 1 with a Play button. Nothing moves until the reviewer acts.
- `intro(c)`: the commit card is shown and its narration is spoken.
- `chunk(c, k)`: the chunk is presented, with its narration first and then its lines.
- `outro(c)`: the finished commit is held on screen.
- `paused(of any of the above)`: everything is frozen and speech is paused. The beat remembers how much of its dwell has run.
- `commenting`: a paused state entered through a comment box. Playback cannot resume while a comment box has focus.
- `finished`: the end card.

#### Timings at 1x

Let `read(t)` = max(2000, 1000 + 300ms per word of t), which is about 200 words a minute plus one second to settle. Let `code(n)` = clamp(1500 + 400ms per non-blank `+` line + 200ms per `-` line, 2000, 9000).

- `intro`: show the card. Speak the narration. Dwell for max(the end of speech + 500, `read(say)`). With speech muted or unavailable, use `read(say)`.
- `chunk` with narration: scroll the chunk to 30% from the top of the viewport (300ms, or instant under reduced motion). Show the narration card next to the chunk and speak it. When the speech ends, or after `read(say)` when silent, reveal the lines as a block (200ms fade, removals turn red and strike through). Then dwell `code(n)`.
- `chunk` without narration: scroll, reveal immediately, show the generated label (see below), dwell `code(n)`.
- A beat of 600ms follows every chunk.
- `outro`: drop the chunk highlight and show the whole commit as a normal diff. Hold for 2500ms, with a thin countdown under the stage header that reads "Next: Reject division by zero". Space during the countdown pauses on the finished commit.
- The transition between commits is a 250ms cross-fade. Scroll to the top only after the outro.

For the fixture this comes to about 2.5 minutes at 1x instead of 15.6 seconds. Speed offers 0.75x, 1x, 1.5x and 2x, down from seven choices. It divides every dwell, beat and hold. It sets the speech rate to min(speed, 1.5), because synthetic voices are hard to follow above that, and dwells still wait for speech to end. Only one utterance exists at any time: call `cancel()` before every `speak()`, and drop any `end` event from an older generation.

#### The screen

- Player bar, fixed width, never reflows. It holds Play/Pause (fixed width, icon plus label), previous chunk, next chunk, previous commit and next commit, then the speed and voice selects and Mute, then a progress strip. The strip has one segment per commit, sized by its chunk count, filled up to the current beat. Clicking a segment seeks to that commit's intro.
- Stage header, sticky at the top of main: "Commit 3 of 8 · Guard add and mul · chunk 1 of 2 · src/lib.js".
- Narration card. This replaces the caption. It is a quote block 15 to 16px tall, not italic, placed directly above the current chunk (the commit intro uses the same card under the commit message). It keeps `aria-live="polite"`. If the browser fires `boundary` events, the spoken sentence is highlighted.
- Current chunk: a 3px accent bar on its left and a soft background. Earlier chunks of this commit are shown normally. Upcoming chunks are one muted row each, "2 lines coming next", in place.
- Lines from earlier commits are plain context. They are part of the file now, so they show no `+` and no dimming. Lines from later commits fold into one row, "4 lines arrive in commit 5", and are never shown dimmed.
- Sidebar: the current commit shows a play glyph, and watched commits show a check.

#### Controls and keyboard

- Space: play or pause. In `ready` and `finished`, Space starts from the top.
- Right arrow or `l`: next beat. Left arrow or `h`: previous beat, which replays its narration if playing.
- `n` or `j` (or Shift+Right): next commit intro. `p` or `k` (or Shift+Left): restart this commit, and press again within 1.5s to go to the previous commit.
- `r`: replay the narration of the current beat.
- `c`: comment on the current chunk. This pauses, opens the chunk's comment box with the chunk's lines preselected, and focuses the textarea.
- In a comment box, Cmd/Ctrl+Enter saves, Escape cancels, and neither resumes. Space resumes once focus has left the box.
- `m`: mute. `?`: a shortcut sheet. Manual stepping while playing keeps playing from the new beat. While paused, it stays paused.

#### Comments inside playback

Clicking any line while playing pauses playback and selects that line. Shift-click extends the selection. The comment box opens under the current chunk, not at the bottom of a long hunk. After a save, the narration card area shows "Comment saved. Space to continue". Comments made during playback are listed in the sidebar badge the same way as in browse. Pause no longer preselects a line on its own (it does now, see q1), because a pause is not always a comment.

#### When narration is absent

This is the normal case for a split review, which never asks for narration, and for plans written before narration existed.

- The commit intro shows the full commit message. The body is the why the prompt asks for. Only the title is spoken. Dwell is `read(message)`.
- A chunk with no narration shows a generated label in the card, such as "src/lib.js · adds 2 lines in `mul`". The function name comes from the nearest preceding context line that starts a declaration. Nothing is spoken.
- If no commit in the plan has narration, the player says so once at the intro ("This plan has no narration. Showing commit messages.") and does not offer the voice controls.

## 2. Review page information architecture

**Narration is invisible outside playback (S).** In browse mode a walk plan's narration appears nowhere, so the author's why only exists inside a 15-second animation. Show the commit narration under the message in both modes, and unit narration above its hunk.

**Line numbers are change indices (M).** The gutter shows `0, 1, 2`, the planner's change index, not file line numbers. Comments then read "c_6hnbcw · lines 2" (q3), which a human cannot locate. Show old and new file line numbers in the gutter and use them in comment metadata. Keep change indices in the API and the planner prompt only.

**Hunk headers speak machine (S).** Every card is headed `h_7da8387be1bf ... takes 2 of 7 changes`. The id is the most prominent text in the card and means nothing to a reviewer. Show `@@` context (the enclosing function) and "2 of 7 changed lines in this commit". Move the id into a copy button or tooltip.

**Ownership labels conflate past and future (S).** In commit 4 (q4), commit 3's `assertNumber` lines are dimmed with `→ commit 3`. They are styled exactly like commit 5's future `pow` lines with `→ commit 5`. Lines from earlier commits already exist in the file at this point and should render as context. Fold later commits' lines into one "4 lines arrive in commit 5" row that links to that commit. Contrast is also a problem: the label is 11px italic muted text at 0.4 opacity, about 1.7:1 on white.

**Comment affordances are hidden and inconsistent (M).** You find line selection only through a hover title. The picked style is the same blue outline as the playback cursor. The yellow `--select-bg` never shows on change lines, because `.dl.add.mine` (three classes) outranks `.dl.picked` (two). Opening a box does not focus its textarea (the active element stayed `BODY`). There is no Cmd+Enter or Escape. The Comment button sits under the whole hunk, which can be far from the selected line. Recommendation: a `+` affordance in the gutter on hover and focus, as on GitHub. Click or shift-click to select a range, open the box directly under the last selected line, autofocus it, and use the yellow selection colour.

**"This belongs elsewhere" is a statement, not an action (M).** It opens a free-text box, so the planner gets prose like "move it up". Label it "Move this commit..." and offer "before commit N" and "after commit N" from a select, plus an optional reason. Store the target in the anchor so the prompt can say "the reviewer wants commit 4 before commit 2". The commit list could later accept drag to reorder, recorded the same way.

**The commit list carries too little (S).** It shows the title and a comment badge. Add a compact `+12 −3 · 2 files` line and a watched or visited check. Make each row a button so it can take focus (see section 6).

**End review is a cliff (S).** Ending with zero comments needs no confirmation and gives no summary. The done screen (done.png) splits its two lines into rows hundreds of pixels apart, because `place-items: center` is applied to two grid rows. Its link is unstyled default blue. "Review saved to reviews/v1.json" drops the `.follow-me/feature/` prefix. Show a summary first ("1 comment on 1 commit. End review?"), then a compact done card with the full path, the next command (with a copy button) and the link to all sessions.

## 3. CLI messages and command naming

**Every step stops without naming the next one (S).** `extract` ends with `session .follow-me/feature`. `check` ends with the commit list. `apply` ends with the proof. Before a draft exists, `check` and `review` both print `follow-me: /private/var/.../draft.json does not exist yet` and exit 1, with an absolute path and no hint. Add one "next:" line to each: after extract, "next: have your agent run `follow-me prompt`, or run `follow-me plan`". After check, "next: `follow-me apply`". After apply, "next: `follow-me review`". The missing-draft error should name the relative path and the two ways to create it.

**Basic CLI conventions are missing (S).** `follow-me --version` and `follow-me --help` both print `unknown command` and exit 1. Running outside a repo prints `git rev-parse --show-toplevel: fatal: not a git repository`. Add `--version`, `-h/--help/help`, and an "is not inside a git repository" message.

**Small text faults (S).** The prompt prints `(1 change lines)`. `status` prints `units: 9 units`. USAGE is a flat list of 15 entries with three paragraphs of server behaviour. Group it by role: author (extract, prompt, plan, check, apply, review, feedback), reviewer (walk, feedback), server, setup.

**walk is blocked by an earlier plan review (M).** After the author's split review of v1, `follow-me walk` prints `plan v1 already has a review; read it with follow-me feedback or plan again first` and exits 1. A reviewer cannot walk a branch whose author reviewed it, and "plan again" is not a command. Walk and split reviews share `reviews/vN.json`. Give walk reviews their own slot (`reviews/walk-vN.json`), or at least name the command that unblocks it.

**Naming (S, mostly fine).** `walk` is a good verb for the reviewer. `prompt` (agent) and `plan` (API) do the same job by two routes, and that is not obvious from the names. `plan --help` and the USAGE line should say "same draft as `prompt`, written by the API". `feedback` reads well. `review` is overloaded: it is the command, the page, and the saved file. Keep it, but say "plan review" and "code review" consistently in output, as the page already does.

**Split feedback does not quote code (S).** A walk review quotes each hunk. A plan review prints `c_6hnbcw on h_0bf3afdec5e8 (change lines 2)`. That is fine for an agent but opaque for the author reading it. Quote the selected lines there too.

## 4. First run, from `npm i -g` to a finished review

The documented path is `npm i -g`, `install`, `extract --base main`, `prompt`, the agent writes a draft, `check` (repeat), `apply`, `review`, comment, End review, `feedback`, `prompt`, and so on. That is seven commands before anything is visible, and the README hands the middle to an agent without saying what to type to the agent.

- Add one entry command, `follow-me split [--base main]`. It extracts, then prints exactly one paragraph. With an agent skill installed: "Ask your agent: *split this branch with follow-me*". With an API key: "Run `follow-me plan`". Otherwise, the prompt path. M.
- In the README, put a 30-second "what you will see" section (the review screenshot plus a GIF of the new playback) before Install, and put the agent sentence in the quick start. S.
- The handoff back to the agent is unclear. The done page says "hand the session to your agent", but the agent does not know the review ended, and with `--detach` nothing waits for it. Add `follow-me review --wait`, which blocks until End review and then prints the feedback. Have the skill use it, so the agent can pick up the comments in the same turn. M.
- `install` with no flags guesses harnesses from the home directory. Print what it wrote and the one sentence to say to the agent. S.

## 5. Reviewer mode and the multi-session index

Reviewer mode opens straight into playback with "Press Play or space to watch this branch being written". Hiding the message and position buttons in walk mode is right. With the new player, walk should open in `ready` on commit 1's intro card. It should show the narration and the branch summary (commits, files, +/−, an estimated watch time such as "about 3 min"), so the reviewer knows the cost before pressing Play. The end-of-plan text "That is the whole branch. Leave any last comments, then finish the code review." is good. Put it in the end card with a Finish button, not in the caption. S.

The index page (idx.png) is an unstyled bullet list: "feature review of plan v1 · 1 comment · /private/var/folders/...". It needs the topbar, one row per session (repo name, branch, a mode badge for plan review or code review, comments, age), the path shortened with `~`, and empty-state copy that links to the docs. The session switcher in the topbar only appears with two or more sessions, which is right. S.

## 6. Accessibility and dark mode

- Commit rows are `li` elements with click handlers and no button role or tabindex. Tab order (t1) is Play, End review, plan note, message, position, comment buttons, and never reaches a commit or a line. Make rows buttons inside the list, give diff lines a roving tabindex inside each hunk with Space to select, and move focus to the commit heading on commit change. M.
- Keyboard shortcuts exist (`n j p k` and Space) but are discoverable only from button titles. Add the `?` sheet and show the keys in the player bar tooltips. S.
- Smooth scrolling in JS (`behavior: "smooth"`) ignores `prefers-reduced-motion`. The CSS guard only covers the type-in animation. Under reduced motion, use instant scroll and no fades. S.
- Speech and screen readers compete: the `aria-live` caption is read aloud while `speechSynthesis` speaks the same words. When a screen reader is likely (the user has turned on "captions only"), default to captions with speech off, and offer that as an explicit toggle beside Mute. S.
- Contrast. `.dl.other` at opacity 0.4 and the ownership labels fail WCAG AA in both themes. Errors appear in `#status` as red text with no icon. Fix both with the ownership redesign above. S.
- Dark mode (d2) is otherwise solid. The palette is coherent, primary buttons have dark text on light blue, and added and removed backgrounds read well. The selection colour `#4a4012` never shows on change lines, for the same specificity reason as in light mode.
- The Play/Pause label change resizes the button and shifts the bar. Use a fixed width. S.

## The ten changes that would improve the product most

1. Rebuild playback as the chunk stepper (section 1, Design B): one utterance at a time, waited for and cancelled on every move; chunk beats; reading-speed dwells; a held outro per commit. M.
2. Add a stage header, a segmented progress strip and next or previous chunk and commit controls with the specified keyboard, so the reviewer always knows where they are and can step by hand. M.
3. Keep removals visible as struck-through lines, render earlier commits' lines as context, and fold later commits' lines into "arrives in commit N" rows. S.
4. Show narration as a readable card next to its chunk, in both play and browse modes, with the generated fallback when narration is absent. S.
5. Show real file line numbers in the gutter and in comments, and replace hunk ids in headers with function context. M.
6. Redo line commenting: a gutter affordance, shift-click ranges, a box under the selection with autofocus, Cmd+Enter and Escape, the yellow selection colour fixed, and `c` from playback. M.
7. Make every CLI step print its next step, and add `--version`, `--help` and a clear not-in-a-repo error. S.
8. Add a `follow-me split` entry command and `review --wait`, so the author-agent loop closes without the user relaying anything. M.
9. Let a reviewer `walk` a plan the author already reviewed (separate walk review files), and turn "This belongs elsewhere" into a structured move. M.
10. Accessibility: focusable commit rows and lines, focus management, smooth scroll that respects reduced motion, AA contrast for ownership marks, a fixed-width Play button, and a styled index and done page. M.
