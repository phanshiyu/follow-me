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

Comprehension. A is weakest because statements arrive in fragments. B is strong. C is strongest for context but weakest for focus. Narration sync. In A the narration overlaps typing. In B the narration comes before the change it explains. In C it plays on top of the highlighted change. Pacing control. A has one knob. B and C have a natural unit (the beat), so "next chunk" means something. The product's identity. A keeps "watch it being written". B keeps it at chunk level. C turns playback into a guided tour. Effort. A is S to M. B is M: a new script shape in `playback.js`, a new stage UI, and the same tests rewritten. C is M and similar to B.

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

`ready`: the page is loaded and shows the intro card for commit 1 with a Play button. Nothing moves until the reviewer acts. `intro(c)`: the commit card is shown and its narration is spoken. `chunk(c, k)`: the chunk is presented, with its narration first and then its lines. `outro(c)`: the finished commit is held on screen. `paused(of any of the above)`: everything is frozen and speech is paused. The beat remembers how much of its dwell has run. `commenting`: a paused state entered through a comment box. Playback cannot resume while a comment box has focus. `finished`: the end card.

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

Space: play or pause. In `ready` and `finished`, Space starts from the top. Right arrow or `l`: next beat. Left arrow or `h`: previous beat, which replays its narration if playing. `n` or `j` (or Shift+Right): next commit intro. `p` or `k` (or Shift+Left): restart this commit, and press again within 1.5s to go to the previous commit. `r`: replay the narration of the current beat. `c`: comment on the current chunk. This pauses, opens the chunk's comment box with the chunk's lines preselected, and focuses the textarea. In a comment box, Cmd/Ctrl+Enter saves, Escape cancels, and neither resumes. Space resumes once focus has left the box. `m`: mute. `?`: a shortcut sheet. Manual stepping while playing keeps playing from the new beat. While paused, it stays paused.

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

## 7. Follow-ups

These answers were written against the tree at `8730ff2`. By then the chunk stepper, the stage header, `review --wait` and separate walk review slots had landed, and plans could carry a Mermaid `diagram` on a commit or a unit.

### 7.1 Long commit titles in the sidebar

What I observed. The sidebar is a fixed 300px column (`.layout { grid-template-columns: 300px 1fr }`). Each row holds the index, the title, a play or check mark and a comment badge. The title is `white-space: nowrap; text-overflow: ellipsis`, which leaves about 220px, or roughly 30 characters at 14px. The fixture fits. Real titles do not: `feat(walk): give walk reviews their own slot` is 44 characters and loses its last third, which is the part that says what the commit does. The selected row also turns bold, which widens the text and cuts it shorter still. Rows are still `li` elements with a click handler and no tabindex, so hover is the only way to reach a tooltip today.

Why it hurts. The sidebar is the table of contents of the story. A reviewer reads it to see the plot before pressing Play, and to judge "This belongs elsewhere". When titles are cut, they have to open each commit to learn what it is.

The options:

- Wrap to two lines at a tighter size. Every title becomes readable and nothing is hidden. It costs some vertical space.
- Full title on hover and focus. It only helps once you already suspect a title is cut, it is invisible on touch, and it needs focusable rows. It is a supplement, not a fix.
- A resizable or collapsible sidebar. Resizing adds a control and a stored width, and it puts the problem on the user. Experience first says no. Collapsing is useful only at narrow widths.
- Compact mode, numbers only, with the title in the stage header. The stage header now names the current commit, so this works well when space is short. It hides the plot outline, though, so it should not be the default.
- Short titles by rule. The prompt asks for "a short imperative title" and sets no number. A 50-character cap is the git convention and fits two lines easily. It is free, but it only governs follow-me's own plans, not the commit titles a walk reviewer meets on someone else's branch.

Recommendation. The primary is a two-line clamp. The fallback, below 900px, is a compact rail. Add the 50-character rule to the prompt as well, so the clamp rarely triggers.

Primary spec (S):

```css
.commit-list li      { align-items: flex-start; padding: 6px 12px; }
.commit-list .title  { white-space: normal; overflow-wrap: anywhere;
                       font-size: 13px; line-height: 1.35;
                       display: -webkit-box; -webkit-box-orient: vertical;
                       -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; }
.commit-list li.selected .title { -webkit-line-clamp: unset; line-clamp: none; }
.commit-list li.selected { font-weight: 400; }   /* the accent bar and background mark it */
.commit-list .index, .commit-list .mark, .badge { line-height: 1.35; margin-top: 1px; }
```

The selected row is never clamped, so the commit you are on always shows its full title. The selected row does not turn bold. Bolding re-wraps the text and makes the list jump. Each row becomes a `<button>` inside its `li`, with `title` set to the full first line only when it is clamped (`scrollHeight > clientHeight`). That gives hover and focus the full text for free.

Fallback spec, with breakpoints (S to M):

1200px and wider: a 300px sidebar with the two-line clamp. 900 to 1199px: a 240px sidebar, same clamp, same 13px. Below 900px: a 56px rail. It shows the number, the mark and the badge stacked, with `.title` hidden. The stage header carries the title. Hover and focus show the full title in a tooltip anchored right of the row (`role="tooltip"`, `aria-describedby`). A "Commits" button at the top of the rail opens the full list as an overlay 300px wide. Escape or picking a commit closes it.

Prompt rule (S). Add to ORDERING: "Keep the title to 50 characters or fewer; put detail in the body." `check` warns, without failing, when a title is over 72 characters: `$.commits[3]: title is 81 characters; keep it to 50`.

### 7.2 A question loop

What I observed. A comment is free text with one of five anchors: hunk with optional change lines, message, position, plan. Every comment is treated as a change request. The prompt says "Answer every comment below with one entry in `responses`, changing the plan where you agree". The only statuses are `addressed`, `declined` and `deferred`. Nothing in `ui/app.js` or `src/server.ts` reads `responses`. The agent's answers are written into `plans/vN.json` and never shown to the reviewer. `lastReview` also ignores walk reviews entirely, so a reviewer's question during a walk can never reach a planner.

Why it hurts. "I don't understand this" is the most common reaction to someone else's code, and today it has to be phrased as a change request. The agent is then pushed to move lines around to "address" it. Its answer, a note in a JSON file, never reaches the person who asked.

#### Question or change request: chosen at creation, with a default inferred from the text (S)

- Every comment box gets a two-option toggle above the textarea: "Ask a question" and "Request a change". In walk mode the second option reads "Code comment".
- The toggle defaults to Question when the text ends in `?` or starts with why, what, how, when, where, is, does, can or should. It flips as the reviewer types until they touch the toggle themselves. After that, inference stops. The kind is never decided silently after saving.
- Questions carry a distinct "?" marker and a neutral blue-grey card (`--question-bg`), not the accent colour. The commit list badge splits into two counts, for example "2 ?" and "1".
- Keyboard: during playback, `q` pauses and opens a question on the current chunk with its lines preselected, and `c` stays as a change request. In browse, select lines and then press `q` or `c`.

#### The wire format change: three optional fields and one status value

1. `Comment.kind?: "question"`. Absent means a change request, so every existing review reads the same. Only `"question"` is ever written.
2. `Comment.follows?: CommentId`. This is set on an "Ask again" comment and names the question it continues.
3. `CommentResponse.status` gains `"answered"`, which is valid only for a question. `CommentResponse.at?: { "commit": number, "unit"?: UnitId }` says where in this plan the explanation lives. `commit` is 1-based, matching how the prompt numbers commits. `unit` names a unit ref in that commit.
4. `Review.resolved?: CommentId[]`. These are the questions from earlier versions that the reviewer marked resolved during this review.

A worked example:

```json
"responses": [
  { "comment": "c_6hnbcw", "status": "answered",
    "note": "The guard sits in each function because callers import them one by one; there is no module boundary to guard.",
    "at": { "commit": 3, "unit": "h_0bf3afdec5e8" } }
]
```

Validation (S). `at.commit` must exist. When `at.unit` is given, that commit must reference it, and that commit or unit ref must carry `narration` or `diagram`. Anything else is an error, because an answer that points at nothing is not an answer. `answered` on a change request is an error. `addressed` on a question is a warning: the agent changed the plan, which is allowed, but probably not what was asked. Optional fields are serialised only when present, so existing plan hashes do not change.

#### Anchoring the answer in the new version (M)

The coordinator's note says change indices are not stable. That is only partly true. A hunk id is a hash of its path and body, so while the id exists its change indices mean the same lines. What moves between versions is which commit holds those lines, and whether they are now split across several commits. The page places each answer like this:

1. If `at` is present, show the answer card on that commit, above the chunk that contains `at.unit`, or under the commit message when there is no unit.
2. Else, for a hunk anchor whose unit still exists, find the commits in the new plan whose refs select any of `anchor.changes` (or any line of the unit when `changes` is null). Show the card at the first one, above the chunk that holds the lowest selected change. If the lines are now spread over several commits, add "continues in commit N" links.
3. Else, if the unit is gone because the branch moved and the hunk was rewritten, show the card only in the Answers panel, labelled "The code you asked about has changed since". It quotes the old lines from the comment snapshot.
4. Message, position and plan anchors use `at`. Without it, they appear only in the Answers panel.

For step 3 to work, the comment snapshot needs the asked-about lines. Add `context.lines?: string[]` to `Comment`, holding the selected change lines as text. That is the only other wire change, and it is also optional.

#### What the reviewer sees in the next version (M)

- On opening a version that answers questions, a banner under the stage header reads "The agent answered 3 of your 4 questions", with a "Show answers" button and a dismiss button.
- An Answers panel in the sidebar, between the commit list and the plan note, lists every question from the previous review. Each entry shows a status: answered, deferred, or not answered (the last is a warning, matching `check`). Selecting an entry seeks to its anchored place.
- An answer card sits inline at the anchored place. It shows:
  - "You asked (v1)" with the question and the quoted lines;
  - "Answer" with the note;
  - "Explained in" naming the narration or diagram it points at. That narration is outlined, and the diagram is drawn right there.
  - Two actions. "Resolved" collapses the card to a single row with a check and adds the id to `Review.resolved`. "Ask again" opens a question box prefilled with `follows` set, and its card shows the whole thread.
- In playback, when a beat reaches a chunk with an unresolved answer, the narration plays first. Then the answer card appears and playback pauses with "Space to continue". The question was the reviewer's own, so this is the moment they care about. Once resolved, the card no longer pauses playback.
- Ending a review with unresolved answers is allowed. The end summary says "2 answers not marked resolved". `follow-me status` reports questions separately: `questions: 4 asked, 3 answered, 1 resolved, 1 asked again`.

#### What the agent must be told (S)

In both `prompt` and `prompt --walk`, add a "## Questions from the reviewer" section. It comes before the change-request comments, and each question is printed with its quoted lines and, for an ask-again, the whole thread. The instruction text:

> A question is not a request to change the plan. Answer it by explaining, not by moving lines. Where the asked-about lines now live, add or rewrite the `narration` of that commit or unit so it answers the question, in plain spoken sentences. When the answer is about flow, structure or order across files, add a `diagram` there too. Then write one response with `"status": "answered"`, a `note` of one to three sentences that answers the question directly, and `"at"` naming the commit (1-based) and unit that carry the explanation. Move lines only if answering shows the order itself was wrong. Say so in the note, and answer the question as well. If the diff cannot answer it, use `"deferred"` and say what is missing.

In walk mode, questions are the one kind of walk comment that does reach the planner. `lastReview` should return a walk review's questions to `prompt --walk` and keep leaving its code comments to `follow-me feedback`. In `feedback`, questions get their own section before the code review, so the author sees them too.

Effort per piece:

Comment kind toggle, inference, markers and the `q` key: S. Wire fields (`kind`, `follows`, `context.lines`, `answered`, `at`, `resolved`) with validation and tests: S to M. Prompt section, walk questions reaching `prompt --walk`, and the `feedback` section: S. Answer placement (`at`, then unit and changes, then the Answers panel): M. Answers panel, inline answer cards, rendering the diagram in place, pausing playback on answers, and Resolved and Ask again: M.

### 7.3 The agent as co-reviewer, and one consolidated report

What I observed. The planning agent only narrates. The plan format has no place for "this looks wrong", so anything it notices while reading every line is lost. `follow-me feedback` for a walk already groups the reviewer's comments by file and quotes each hunk with its line on the branch (`renderCodeReview` in `src/prompt.ts`). Within a file, though, it lists comments in the order they were written, not by line, and it has no severity. The done page shows only "Code review saved to reviews/vN.json" and the command to run, with nothing the reviewer can copy or send.

Why it hurts. The agent has read the whole diff and is well placed to spot a missing test or an unguarded edge. The reviewer then has to find and phrase every issue alone, and send it by running a CLI command.

(a) Wire format (S to M). Add `concerns?: Concern[]` to a commit and to a unit ref object, next to `narration` and `diagram`. The agent writes `Concern` as `{ "severity": "blocker" | "major" | "minor", "kind": "bug" | "missing-test" | "naming" | "risk", "text": string, "lines"?: number[] }`. `lines` holds change indices of that unit and is allowed only on a unit ref. Validation derives an id `k_` plus 8 hex of sha256 over unit ref, lines and text, so the agent never writes ids and they survive re-planning unchanged. The review records the reviewer's decisions as `Review.concerns?: { "concern": "k_…", "decision": "kept" | "dismissed", "note"?: string }[]`. Reviewer comments gain `Comment.severity?: "blocker" | "major" | "minor"`, absent meaning unrated. Plans without concerns serialise and hash exactly as before.

(b) In the review page (M). A concern is a card in reviewer voice, never read aloud and visually distinct from narration. It carries an "Agent" label, a severity chip (blocker red, major amber, minor grey, each with a text label and not colour alone) and the kind. A unit concern sits directly under its lines, with those lines marked in the gutter. A commit concern sits under the message. It has three actions:

Keep: the card turns solid and a "Your words (optional)" field opens. Dismiss: the card collapses to one muted row with Undo. Edit severity: the reviewer can change the agent's severity.

During playback a concern appears after its chunk's narration. A blocker pauses playback; major and minor concerns add `read(text)` to the dwell. The keys `y` (keep) and `x` (dismiss) act on the concern of the current chunk. The commit list shows a severity dot for undecided concerns, and the stage header shows "2 agent concerns to decide". The reviewer's own comment box gains the same optional severity chip. Undecided concerns are left out of the report. Ending the review with any left asks "3 agent concerns undecided: Keep all, Dismiss all, or Go back".

(c) The consolidated report (M). One renderer, `renderReport(review, plan, units)`, produces the markdown. `follow-me feedback` prints it, and the server serves it at `GET /s/<id>/api/report` for the done page, so the two never differ. Its shape:

````
# Code review: feature (8 commits, 3 issues: 1 blocker, 1 major, 1 minor)
## src/lib.js
### line 14 · blocker · bug · raised by the agent, kept by the reviewer
```diff
   export function div(a, b) {
+    if (b === 0) throw new RangeError('division by zero');
```
Agent: div guards zero but not non-numbers, unlike add and mul.
Reviewer: Agreed, and pow has the same gap.
## General
````

Files appear in diff order, and items within a file by line on the branch. Severity and kind sit in the heading, so the report can be skimmed. A reviewer comment and a kept concern on overlapping lines merge under one heading, and both voices are quoted. Questions from 7.2 come last, under "## Questions", with the agent's answers. The done page shows the report in a scrollable `<pre>` with "Copy markdown" (with a "Copied" confirmation), and the file path `.follow-me/<slug>/reviews/vN.md`, which `End review` also writes.

(d) The prompt (S). Add a "## Concerns" section to `prompt --walk`:

> You are also a careful reviewer. Add a concern only for something you would raise in a pull request: a bug or unhandled case, a change with no test where one is expected, a name that misleads, or a risky change such as a migration, concurrency or security. Pin it to the change lines with `lines`. Say what goes wrong and when, in one or two sentences. Severity: `blocker` breaks behaviour or loses data, `major` should be fixed before merge, `minor` is worth a note. Do not flag style, formatting or taste. Do not repeat the narration. Most commits deserve no concern, and a plan with none is fine. Never write more than one concern per unit. Concerns are in your voice as a reviewer, while narration stays the author's.

`check` prints the concern count by severity, so padding is visible, and enforces the one-per-unit limit as an error.

(e) The split review (S). Yes, with a different audience. In a split review the planner is the author's own agent, so its concerns are a self-review before anyone else sees the branch. The split report has two parts. "Plan feedback" holds the comments the planner answers through `responses`, as today. "Code issues" holds the kept concerns and any comments marked with a severity, which the author fixes on the original branch before running `extract` again. Kept concerns never enter `responses`, because they are about the code, not the order.

Effort per piece:

Wire fields and validation: S to M. Inline concern cards, keep and dismiss, and the end-of-review prompt: M. `renderReport`, the `/api/report` endpoint, the done page, and writing `vN.md`: M. The prompt section: S. The split report's two parts: S.

## 8. Conversation

This section was written against `458d573`. By then the question loop, replies (`follow-me watch` and `follow-me reply`), concerns, syntax highlighting and the Mermaid side panel were all built.

### 8.1 Comment on any line

What I observed. In `diffLine` (`ui/app.js`), only the commit's own `+` and `-` rows get the `+` gutter button, the click handler and a roving tabindex. Context rows and lines from earlier commits are plain `div`s. `pickLine` builds ranges from `ownLines`, so a shift-click from a context row does nothing, and a range across context silently drops the context rows. On the wire, `Anchor.hunk.changes` holds change indices, which cannot name a context line at all.

Why it hurts. The questions that matter often point at the code around the change: "why doesn't `div` get the guard too?" points at an untouched `return a / b;`. The reviewer has to anchor to the nearest changed line and explain in prose where they meant.

Recommendation (S to M):

- Selection. Every rendered row of a hunk can be picked: context, added, removed, struck-through removals, and earlier commits' lines that now render as context. Fold rows ("4 lines arrive in commit 5") stay buttons and are not selectable. Click picks one row. Shift-click extends from the anchor row to any row in the same hunk, and a range may mix context and changed rows. A drag in the gutter selects a range. A pick never crosses hunks; a shift-click into another hunk starts a new pick there. Picked rows use the yellow selection colour with a 3px accent bar in the gutter. Every row shows the `+` gutter button on hover and focus.
- Keyboard. Each hunk is one tab stop, and the roving focus covers all rows. Up and Down move the focus. Shift+Up and Shift+Down extend the pick. Space or Enter toggles the focused row. `c` and `q` act on the pick when there is one, else on the current chunk as today. Escape clears the pick. Selection pauses playback, as it does now.
- Wire. Add `Anchor.hunk.offsets?: number[]`: sorted 0-based indices into the unit's hunk `body`, covering context, `+` and `-` rows alike. `changes` keeps its meaning. It holds the change indices inside the pick, and is `[]` when only context is picked, so placement and older readers still work. Offsets are as stable as change indices, because the unit id hashes the body: while the id exists, offset 9 is the same row. `context.lines` already snapshots the text. The validator checks that each offset is less than the body length and that `changes` equals the change indices of the offset rows owned by that commit.
- Inline placement. The open composer, then the saved comment chip, sits directly under the last picked row, not under the hunk. Every row in a saved anchor keeps a thin marker in the gutter, so the reader can see what was meant.
- What the agent sees. `describeAnchor` in the prompt and in `watch` should print the file line and quote the rows, marking the picked ones:

```
- new question c_8k2pqa on src/lib.js:17-18 in commit 4 (h_7da8387be1bf rows 9-10; 1 context line, 1 added)
  >   export function div(a, b) {
  > +   if (b === 0) throw new RangeError('division by zero');
        return a / b;
  - why does div not call assertNumber like add and mul?
```

The prompt adds one rule: "A comment on context lines is about code this branch leaves alone or depends on. It cannot be moved in the plan. Answer a question with narration, a diagram or a reply. Answer a change request as a code issue, not by reordering." Placement of an answer for a context-only anchor goes to the first commit in the new plan that takes any line of that unit, at the same offset.

### 8.2 A conversation panel on the right

What I observed. Today the conversation is in four places:

- Replies sit inline under their comment (`replyView`), and reply diagrams render inline too.
- Previous answers are in a sidebar "Answers" section and in inline cards.
- Concern decisions show only on the concern cards.
- The right-hand `aside#diagram` (380px, 300px below 1200px) shows only the planned diagram for the current commit or beat.

The server already keeps an ordered event log (`comment`, `reply`, `concern`, `resolved`, `version`, `ended`, each with a `seq`), and the page already follows it over SSE. At 1280px the grid is 300px sidebar, 600px code and 380px panel. At 1024px it is 240px, 484px and 300px, about 55 characters of code.

Why it hurts. The reviewer and the agent are having a conversation, but it is scattered across the code, the sidebar and a panel that ignores it. You cannot read back what was asked and answered in order. The agent can only speak by replying to something the reviewer wrote.

Recommendation: one right-hand column, merged with the Mermaid panel rather than stacked beside it. Two right columns would leave under 500px for code. From top to bottom:

1. A "Now" card, collapsible. It holds the planned diagram for the current commit or beat (today's panel content), a one-line label ("Diagram · src/lib.js, commit 3"), and "2 threads here", which filters the timeline to entries anchored to this chunk.
2. The timeline, oldest first, auto-scrolled to the bottom unless the reader has scrolled up. If they have, a "1 new ↓" pill appears. It holds these entries:
   - Reviewer comments and questions ("You", a kind chip, an anchor chip such as `src/lib.js:17-18 · commit 4`, the quoted rows collapsed to three, and the body).
   - Agent replies (with a "re:" stub naming the parent and its anchor).
   - Agent-started explanations.
   - Concern decisions, as compact system rows ("You kept the agent's concern, major bug, on src/lib.js:17").
   - Resolve and reopen rows.
   - Version dividers ("Plan v2 opened · answers 3 of 4 questions"), each followed by that version's answer cards.
   - The end of the review.
3. A composer pinned to the bottom. It holds a question / change-request toggle, an anchor chip, and a textarea with Cmd+Enter to send. With nothing picked, the chip reads "Whole branch", and the comment is `{ "anchor": { "kind": "plan" }, "kind": "question" }`. With rows picked, the chip shows the anchor and quotes the rows, and × clears it. No new `chat` anchor kind is needed. `plan` plus `kind: "question"` already means "a question about the whole thing", and `follow-me reply` already answers it. `check` should count an agent reply as an answer to a question, so a live answer does not also need a `responses` entry.

Inline cards. Remove the inline threads, and keep one inline chip per anchor under its last row: "Question · 2 replies · answered". Clicking the chip focuses its thread in the panel. Writing then happens in exactly one place, a thread has one copy whose state cannot disagree with itself, and the code stays readable, while the chip still shows that a line has discussion. Concern cards stay inline, because they are proposals about the code that need keep or dismiss right there. Their decisions are also logged in the timeline.

Clicking an entry with an anchor:

- selects its commit and scrolls the anchored rows to 30% from the top;
- flashes them for 1.2 seconds and moves the roving focus there;
- if playing, pauses and seeks to the beat that contains the anchor, so the rows are not hidden;
- for a stale anchor (the unit is gone), shows the quoted rows in the entry and does not scroll.

During playback. The timeline does not follow the player. Its order is the order of the conversation, and jumping it to each chunk would make it unreadable. The player drives the Now card instead: its diagram follows the beat, as the Mermaid panel does today. Timeline entries anchored to the current chunk get an accent edge, and the Now card shows "2 threads here". An agent reply that arrives mid-playback does not pause it or get spoken. The panel tab gets an unread count. A reply to a question the reviewer asked during this playback raises a toast, "Agent replied · Show".

Long replies and diagrams in a narrow column:

- Replies render as plain paragraphs, with backtick spans in monospace and fenced blocks as scrollable `pre`.
- A reply longer than 12 lines collapses with "Show more".
- A diagram renders at the column width, with a maximum height of 280px, and an "Expand" button that opens it in a `dialog` at up to 90vw by 85vh with scroll and fit-to-width. In a 360px column, a wide `flowchart LR` is unreadable unless it can be expanded.
- A Mermaid error shows the source collapsed under the message, as today.

Wire changes, all optional:

- `Anchor.hunk.offsets?: number[]`, from 8.1.
- `Comment.author?: "agent"`. Absent means the reviewer. This lets the agent start a thread, for example to explain a chunk before anyone asks. It needs a new command, `follow-me explain [--commit <n>] [--unit <h_x[:offsets]>] --body <text> [--diagram <file>]`, and `watch` leaves these out as it leaves out the agent's own replies.
- `ConcernDecision.decidedAt?: string`. Comments and replies already carry `createdAt`, so with this the timeline can be rebuilt in order from saved state after a server restart, when the in-memory event log is gone. Version dividers come from the live log, or after a restart from the version each comment belongs to.

Layout. The panel replaces `aside#diagram` and is always present while a review is open, with a collapse control that leaves a 40px tab carrying an unread count.

- 1440px and wider: sidebar 300px, code at least 720px, panel 400px.
- 1280px: sidebar 240px with the two-line clamp, code 680px, panel 360px.
- 1024px: the commit rail (56px) takes over from the sidebar here rather than at 900px, the code gets about 648px and the panel 320px.
- Below 900px: the panel becomes an overlay drawer 360px wide from the right, opened by its tab, an inline chip, or `t`. Escape closes it.

Every width keeps at least about 75 characters of code visible. When the reader needs room, the panel gives way first and the code never does.

Effort per piece:

- 8.1 selection, keyboard and offsets: M.
- Prompt and `watch` quoting: S.
- Panel shell merged with the Now card, and the timeline built from state and the event log: M.
- Composer with plan-anchored questions, and agent replies counting as answers: S.
- Inline chips replacing inline threads, with click-to-anchor: M.
- `Comment.author` and `follow-me explain`: S to M.
- Long-reply collapse and the diagram expand dialog: S.
- Breakpoints and the drawer: S.

What to build first:

1. Offsets, any-line selection and keyboard selection. This is the owner's direct ask, and everything below anchors through it.
2. Prompt and `watch` quoting of anchors with file lines, so the agent can see what the reviewer meant.
3. The panel shell: merge the Mermaid panel into the Now card, and render the timeline from the existing event log with click-to-anchor.
4. The composer for whole-branch questions, with agent replies counting as answers.
5. Inline chips replacing inline threads, once the panel holds the threads.
6. `follow-me explain` with `Comment.author`, so the agent can explain unprompted.
7. Diagram expand, long-reply collapse, the breakpoints and the drawer.
8. `ConcernDecision.decidedAt`, and rebuilding the timeline after a restart.

## 9. Simplify

The owner tried the page at `a4a57c7` and rejected the direction: "the play function is not practical … extremely clunky all around." This section replaces sections 1 and 8.2 and the playback parts of 7.2 and 7.3. The product is now four verbs: read the commits in order, flag things, ask questions, get answers. Anything that does not serve one of them goes.

### 9.1 Cut list

- Playback goes entirely:
  - the Play/Show all toggle, the player bar (Play, ⏮ Commit, ◀ Chunk, Chunk ▶, Commit ⏭, Speed, Voice, Mute, `?`) and the progress strip;
  - the stage header with chunk counters, the outro countdown, the intro cards and the ▶/✓ watched marks;
  - pausing for concerns and answers, and the chunk highlight and type-in styles;
  - `ui/playback.js` (591 lines) and its tests.

  Nothing replaces it. Reading order comes from the document itself (9.2).
- Speech goes: `speechSynthesis`, the voice picker, mute and the `m` key. Nothing replaces it.
- The right-hand conversation column goes: the Now card, the timeline, the new-messages pill, the unread count, "threads here", the pinned composer, the panel tab and drawer, the toast, the `t` key, and `ui/timeline.js` (575 lines). Threads move back inline under their lines (9.2). Unanchored questions move to a popover. Diagrams move inline at full width.
- The inline thread chips go. The full thread returns inline, where the chip used to be.
- The sidebar goes: the commit list, the 56px rail and its tooltip, the Commits toggle, the Answers section and the Plan note section. The commit list is replaced by a sticky header with a stack popover. Answers sit inline where they belong, plus a branch discussion block at the top. The plan note becomes "Flag" in the branch popover.
- The answers banner ("The agent answered 3 of 4") goes. It becomes one line in the branch summary at the top of the page, linking to the first unread answer.
- Keys go: Space, ← → h l, Shift+arrows, `r`, `m`, `t`, `y`, `x`, and the "press `p` twice" restart. Section 9.3 gives the keys that remain.
- In the CLI:
  - `walk` merges into `review` (9.5).
  - `--walk` disappears from `prompt`, `plan` and `feedback`.
  - `report` and `feedback` become one command. `report` is the name, `feedback` an alias, and `report --json` is the export.
  - `split`, `extract`, `prompt`, `plan`, `check`, `apply`, `review`, `feedback`, `watch`, `reply`, `explain`, `status`, `server`, `install`, `uninstall`, `upgrade` and `clean` stay.
- Narration earns its place only as plain text, and only once:
  - A commit's `narration` renders as one paragraph under the commit message, labelled "Agent's note". It is hidden when it repeats the message body.
  - A unit's narration renders as one muted line above its hunk.
  - The prompt stops asking for first-person "thinking aloud". For the author, the why belongs in the commit message body, which ships with the commit. For a reviewer reading someone else's branch, the prompt asks for a short third-person note on what to look at in each commit.

### 9.2 The interaction model: one document, everything inline

Navigation: one scrolling document of commits, not a list beside a pane. Reading in order is the product, and scrolling down is reading in order. Browser find works across the whole branch, and nothing is stored about which commit is "selected". It also frees the 240 to 300px the sidebar took, so code gets the width. Long branches stay usable through the stack popover, the `j`/`k` keys, per-commit "Viewed" collapse, and `content-visibility: auto` on commit sections.

Page structure, top to bottom:

1. A sticky header, 44px tall, which absorbs the old topbar:
   - on the left, "follow-me · feature · plan v2";
   - in the centre, the stack button "Commit 3 of 8 · Guard add and mul ▾", which tracks the commit at the top of the viewport;
   - on the right, "Ask about the branch", the pending count "Review · 3 pending" and "Submit review".
2. A branch summary: commits, files and lines changed, and "v2 answers 3 of your 4 questions → first answer". Below it, the branch discussion threads (unanchored questions and agent explanations).
3. Each commit as a section:
   - A commit header: number, title, a Viewed checkbox and a ⋯ menu ("Comment on message", "Move this commit…"; split only). It sticks under the page header while its commit is on screen.
   - The message body, the Agent's note, and the commit diagram if there is one.
   - Unanchored agent explanations (`follow-me explain` without `--unit`).
   - Then files, each with a path line and its hunks.
4. The end-of-review report is a separate page (9.4).

A hunk reads as one diff:

- The header shows `@@` and the enclosing function. Hunk ids are only in the tooltip.
- Old and new line numbers, syntax highlighting, and removals in red. Lines from earlier commits render as plain context. Lines from later commits fold into one row, "4 lines arrive in commit 5", which links down the page.
- A unit diagram, if any, sits full-width above its hunk.

Selection and commenting happen under the lines, and nowhere else:

- A pick can include any row (8.1 offsets). The selection model is in "Borrowed patterns" below.
- Once rows are picked, a floating pair of buttons, **Flag** and **Ask**, appears at the right edge of the last picked row.
- Either opens a box inserted directly under that row. Flag offers optional severity chips (blocker, major, minor) and saves a change request. Ask saves a question.
- Cmd+Enter saves and Escape cancels.

Threads, concerns and explanations are all cards in the same column:

- A thread is a card inline under its last anchored row. It shows the reviewer's text, then the agent's replies indented with an "Agent" label and any diagram at full card width, then "Reply" and "Resolve".
- A resolved thread collapses in place to one muted line, "✓ Resolved · why does div…", with Reopen.
- An agent concern is the same card shape, labelled "Agent flagged · major · bug", with **Keep** and **Dismiss** buttons and a severity chip. Keep turns it into a flag in the review. Dismiss collapses it like a resolved thread.
- An agent explanation anchored to lines reads exactly like a thread that the agent started.

Unanchored questions are asked from "Ask about the branch" in the header. It opens a 420px popover anchored to the button, with a textarea, a Flag/Ask toggle and Send. The thread then appears in the branch discussion block, and the popover closes. A commit-level question uses "Comment on message" in the commit's ⋯ menu, and the box opens under the message.

Diagrams are inline, at full content width:

- A commit diagram sits under the message. A unit diagram sits above its hunk. A reply diagram sits inside the reply.
- Each renders fit-to-width with a maximum height of 480px at 1280px and 360px at 1024px.
- Clicking opens the existing `diagram-dialog` as a lightbox at 95vw by 90vh, with Fit and Actual size.

Sizes:

- At 1280px: no side columns. The content column is 1232px wide (24px gutters). Diffs use the full width. Prose (message, note, comments, replies) is capped at 72ch, about 640px. Comment and thread cards are indented to the code column, start about 96px in, and are up to 760px wide.
- At 1024px: the same layout with a 992px column and the same caps.
- Below 900px: the header drops the centre title to "3/8 ▾", and nothing else changes.

### 9.3 Borrowed patterns

Sources checked on 2026-10-21: GitHub Docs (commenting on and reviewing pull requests), GitLab Docs (merge request commits), Google Docs Help (comments), Gerrit's review UI docs, Reviewable's docs and Graphite's review docs. Phabricator's docs did not load (503 and 403 responses), so nothing below relies on Phabricator.

**Selection and the comment affordance.** We copy three things:

- From GitHub: hover a line and click the blue comment icon. For a range, "click the line number of the first line … then either drag down to the final line, or hold down Shift and click on the last line number". Our gutter `+` appears on hover and focus of every row. A gutter drag or Shift-click selects a range within one hunk.
- From Graphite: commenting "anywhere, not just on lines that have changed". This is our context-line picking.
- From Google Docs: the comment attaches to the highlighted selection and is shown next to it. The help page only documents the toolbar "Add comment" button, so the floating Flag/Ask pair beside the selection is our own choice, not something that page confirms.

Text selection also counts: selecting text inside the code with the mouse picks the rows it spans and shows the floating buttons. No toolbar or right-click step is involved.

**Sending comments to the agent.** Copy GitHub's two paths: "Add single comment" posts immediately, while "Start a review" batches comments until "Submit review". GitHub notes that batching "stops the assistant from acting on individual comments prematurely". Gerrit also keeps comments as drafts until the reviewer clicks Reply.

Recommendation: questions send on save, because the reviewer wants the answer while still reading and `watch` delivers it live. Flags are pending until **Submit review**. The header shows "Review · 3 pending", and pending cards carry a "Pending" tag. The box's primary button follows the kind ("Ask now" or "Add to review"), with the other path as a secondary button.

Submit review replaces End review. It opens a dialog with an optional summary and the undecided agent concerns (Keep all, Dismiss all, Go back). Then it sends the batch, ends the review for this plan version, and navigates to the report page.

**The per-commit Viewed mark.** Copy GitHub's Viewed checkbox: marking a file viewed collapses it, and "if the file changes after you view the file, it will be unmarked". Gerrit offers a per-file Reviewed checkbox, with a preference to check it automatically on viewing. Reviewable's `n` key cycles to the next unreviewed file.

Our version works per commit:

- The checkbox is in the commit header. Checking it collapses the commit to its header and jumps to the next unviewed commit.
- A new plan version keeps the mark only if the commit's units and line selections are unchanged (same refs). Otherwise it clears the mark.
- `v` toggles the mark on the commit at the top of the viewport.

**The stack overview.** Copy Graphite's "Show stack" button, with `S` as its shortcut, which shows where the current PR sits and lets you jump to any other. Also copy GitLab's Prev/Next commit buttons and their `X`/`C` keys.

Our version is the centre header button "Commit 3 of 8 ▾" (and `s`). It opens a popover listing every commit with:

- its number and full title, wrapped and never truncated;
- a Viewed tick;
- an open-thread count (red when one is waiting on the reviewer, as Reviewable shows discussions that are waiting or unresolved), a pending-flag count and an undecided-concern dot.

Clicking a commit scrolls to it. Prev and Next arrows sit beside the button.

**Resolve in place.** Copy GitHub's resolve-conversation behaviour: a thread collapses where it is. Gerrit marks a comment "Done" in a later patch set. An answer arriving in a new plan version appears inline at its placed location (7.2), with Resolve and Ask again. Resolved threads stay collapsed across versions.

**Revision comparison.** Gerrit and Reviewable both diff one revision against another. We copy only the minimum: when version N+1 opens, commits whose refs changed get a "changed in v2" tag in the stack popover and in their header. A full version-to-version diff is out of scope.

**The keyboard model.** Copy Reviewable's `n` (next unreviewed) and its `?` sheet, which Gerrit also has. Copy GitLab's commit stepping.

- Commits: `j` or `c` goes to the next commit, `k` or `x` to the previous one, `n` to the next unviewed commit, `v` toggles Viewed, `s` opens the stack.
- Rows inside a focused hunk: ↑ and ↓ move, Shift+↑ and Shift+↓ extend the pick, Space toggles a row, `f` flags, `a` asks, Escape clears.
- Threads: `u` goes to the next unresolved thread (Reviewable's `⇧J`, simplified) and `r` replies to the focused thread.
- Review: Cmd+Enter saves a box, and Cmd+Shift+Enter submits the review.
- Every key is listed on the `?` sheet.

### 9.4 End of review: the hand-off to the merge request

follow-me is always driven from a coding agent's harness and never holds an API key or a forge token. The working tree has already removed the API planner, leaving only `plan --naive`. The end of the review is therefore a hand-off: review locally, ask, understand, consolidate, then carry the result to the GitLab merge request or GitHub pull request.

**The report page.** Submit review navigates to `/s/<id>/report`. It has the same header, without Submit, and with "Back to review" while the session is still open. Each item is one card:

- The location is given on the original branch, not the split branch, for example `src/lib.js:17-18 (new)` or `:12 (old)` for a removed line. The split's last tree equals the tip (the apply proof), so new-side line numbers are the tip's own, and old-side numbers are the base's. These are exactly the lines a merge request shows when it diffs the same base.
- The card also shows:
  - the severity chip and kind (flag, question, or kept concern);
  - the quoted hunk lines;
  - the reviewer's words;
  - the agent's answer, for a question;
  - the rest of the thread, collapsed;
  - the resolved state.
- Each item has an **Include** checkbox. By default, flags and kept concerns are included. Questions are excluded, because most were asked to understand the code locally; tick one to ask the author too. An unresolved question shows "still open" next to its checkbox.
- Items are grouped by file in diff order, then by line, with general items (message, position, branch) last.
- Each card has one **Copy comment** button. It copies the body markdown: a severity line, the reviewer's text, and the agent's answer in a `<details>` block. It also has **Copy path:line** for pasting by hand. GitLab and GitHub both render that markdown and `<details>` the same way, so separate "GitLab" and "GitHub" copy buttons would only differ in name. Use one button and two separate exports instead.
- The top of the page carries the counts ("6 included · 2 excluded"), **Copy all as markdown**, and the exact command for the agent: `follow-me report --json`.

**The export, `follow-me report --json`.** It prints the included items. `--all` adds the excluded ones, marked `"included": false`.

```json
{ "schema": "follow-me/report@1", "branch": "feature", "base": "<sha>", "head": "<original tip sha>",
  "summary": "<review summary text>",
  "items": [ { "id": "c_8k2pqa", "path": "src/lib.js", "oldPath": "src/lib.js",
    "newLine": 18, "oldLine": null, "startNewLine": 17, "startOldLine": null,
    "severity": "major", "kind": "flag", "body": "<markdown, ready to post>",
    "thread": [ { "author": "reviewer", "body": "..." }, { "author": "agent", "body": "...", "diagram": "..." } ],
    "resolved": false } ] }
```

The fields:

- `kind` is `"flag" | "question" | "concern"`.
- `severity` is null for unrated items.
- `newLine` and `oldLine` are the last line of the range. For a context row both are set, for an added row only `newLine`, and for a removed row only `oldLine`.
- `start*` are null for a single line.
- `path` is null for an item with no lines.
- `body` is the same markdown that Copy comment produces.

The include and exclude decisions are stored as one new optional field, `Review.excluded?: string[]` (item ids). The page writes it, and `report --json` reads it.

**What the skill tells the agent.** A new section, "Porting a review", says:

1. Run `follow-me report --json`. Show the user how many items there are and their titles. Ask which merge request or pull request to post to, and whether to post. Never post without a yes.
2. Find the target with the user's own CLI:
   - GitLab: `glab mr view <iid> --output json`, which gives `diff_refs`.
   - GitHub: `gh pr view <n> --json headRefOid,baseRefName`.
   - If the merge request's head is not the report's `head`, say so and stop. The line numbers would be wrong.
3. GitHub: build one review and post it once, with `gh api repos/{owner}/{repo}/pulls/<n>/reviews --input review.json` and `"event": "COMMENT"`. Put each item in `comments[]` as:
   - `path`;
   - `line` = `newLine` with `side` = `"RIGHT"`, or `oldLine` with `side` = `"LEFT"`;
   - `start_line` and `start_side` for a range;
   - `body`.

   Items with no line go into the review `body`. Never use `APPROVE` or `REQUEST_CHANGES` unless the user asks.
4. GitLab: post one discussion per item, with `glab api --method POST projects/:id/merge_requests/<iid>/discussions` and `position[position_type]=text`. Take `base_sha`, `start_sha` and `head_sha` from `diff_refs`, and set `new_path`, `old_path`, `new_line` and `old_line` from the item: `new_line` for an added line, `old_line` for a removed line, and both for a context line. Post items with no line with `glab mr note`.
5. Report what was posted, with links, and anything that failed. Do not retry blindly.

Credentials stay entirely with `gh` and `glab`. follow-me never stores, reads or asks for a token.

### 9.5 The wire format and the CLI

- The plan format keeps everything. `narration`, `diagram` and `concerns` are text and cost nothing when absent. Removing them would break the hashes of existing plans. Only the prompt changes (9.1).
- The review format keeps comments (`kind`, `severity`, `follows`, `replies`, `author`, `offsets`), concern decisions and `resolved`. It adds one optional field, `Comment.pending?: true`, for flags not yet submitted. It is cleared on submit and never written to `reviews/vN.json`.
- `decidedAt` stays but is now unused. Events stay, because `watch` needs them.
- Merge `walk` into `review`. Without playback the two modes differ only in who reads the result. The author's review offers "Comment on message" and "Move this commit…". Someone else's review hides them and writes a code review. Decide by whether this session has applied a split branch, not by a flag.
- `follow-me review` on a branch with no plan plans one, exactly as `walk` does now. Keep `walk` as an alias that prints "walk is now review" for one minor release, then delete it. `Review.mode` keeps being written for the report's sake, but no UI branches on it beyond those two menu items.

### 9.6 Build order, deletions first

1. Delete playback, speech, the player bar, the strip, the stage, their keys, `ui/playback.js` and its tests. S to M.
2. Delete the conversation column, `ui/timeline.js`, the chips, the toast and `t`. Restore inline threads (`commentView` and `replyView` still exist). M.
3. Delete the sidebar, the rail and the Answers and Plan note sections. Render all commits as one document with sticky commit headers. M.
4. Add the sticky page header with the stack popover, Prev and Next, and the Viewed checkbox with its collapse and reset rule. M.
5. Add the floating Flag and Ask buttons on the selection, the box under the lines, text-selection picking, and the keyboard model. M.
6. Make questions send immediately and flags pending, with the pending count, Submit review and its dialog. Add `Comment.pending`. M.
7. Render concerns, answers and resolved threads inline in the new card shape, and show narration as the Agent's note. S.
8. Show diagrams inline at full width with the lightbox. Add the "Ask about the branch" popover and the branch discussion block. S.
9. Add the report page at `/s/<id>/report` with Include toggles and Copy comment, sharing the `feedback` renderer. Add `report --json` and `Review.excluded`. Add the skill's "Porting a review" section. M.
10. CLI: merge `walk` into `review`, drop `--walk`, keep `report` (it now owns `--json`) and make `feedback` its alias, and change the prompt to ask for the why in the message body rather than first-person narration. S.

## 10. Offers, state machines and coverage

This section was written against `6731bf8`. The React page there has the scrolling document, a sectioned index beside it, inline threads with markdown replies and Mermaid, the lightbox, and Cmd-click go-to-definition with a Back chip and a peek. The constraints are fixed:

- follow-me never calls a model and never runs tests. The agent does both in its own harness and talks to follow-me through the CLI and the event loop.
- Coverage is evidence only if it comes from an actual test run, handed over as lcov.

Sources checked on 2026-10-22:

- VS Code testing docs: gutter overlay, hit count on hover, Show Inline Coverage, and a toolbar that navigates between uncovered blocks.
- IntelliJ coverage docs: green, yellow and red gutter marks; clicking a mark shows hits and true/false branch hits; "Show tests that cover the code line" when per-test tracking is on.
- Codecov GitHub checks: uncovered added lines are annotated in the Files changed view, and "patch" status covers only the change.
- GitHub code scanning: alerts appear as annotations in the diff and are dismissed from the annotation with a reason.
- coverage.py contexts: `dynamic_context = "test_function"` and pytest-cov `--cov-context=test` record which test ran each line.

The Stately and XState pages I fetched did not describe their interaction (one returned 404), so nothing below claims their behaviour.

Recommendation up front: build coverage first, on its own. It needs no judgement from the agent, it uses a standard file, and it answers the owner's sharpest question ("what code paths have been covered … as I read"). Offers come second, built generically for any diagram. Coverage on state machines comes last, once offers prove they are used.

### 10.1 Coverage while reading

How it arrives:

- The agent runs the project's suite with coverage at the branch tip, then runs `follow-me coverage <lcov> [--test <id> [--at <path:line>]]`.
- Per-test detail comes either from repeated `--test` calls, one lcov per test, or from one lcov with several `TN:<test id>` blocks. lcov's own test-name record carries the id.
  - Go: run each test with `-run '^TestX$' -coverprofile` and convert.
  - coverage.py: run with `--cov-context=test` and export one lcov per context.
  - Tools without per-test detail give an aggregate only, and that is fine.
- The command makes lcov paths relative to the repo root. It records the tip sha and the time. It refuses with "coverage must be taken on the tip; these files differ: …" when any covered path in the working tree differs from the tip. It writes `.follow-me/<slug>/coverage.json`, and if the session is hosted, posts it so the server emits a `coverage` event and the page reloads its marks.

Mapping. Every row the page shows has a tip number or a base number. The split ends on the tip's tree, so each added row in any commit is a tip line. A context row maps if it still exists at the tip. Base-only rows (removed lines, and context removed by a later commit) show no mark. lcov `DA:<line>,<hits>` gives covered or not covered. `BRDA` with some branches untaken gives partly covered. A line with no `DA` record is not executable.

Gutter marks:

- A 3px bar at the far left of the gutter, before the hover `+`:
  - covered: solid green;
  - partly covered: amber, upper half only;
  - not covered: red;
  - not executable or not at the tip: nothing.
- Every mark has screen-reader text ("covered, 14 hits"). The amber shape and the red bar differ in form as well as colour, so they read in dark mode and for colour-blind readers. Dark mode uses the same hues at reduced brightness on the dark gutter, keeping a contrast ratio of at least 3:1.
- Marks show on rows of every kind. The summary counts only executable added rows, which is Codecov's "patch" idea.

Summaries:

- The commit header gets a chip after the title, "18/24 covered", with a 40px bar. It is red when any added row in the commit is not covered.
- Each file line gets "6/7".
- The index gets one small dot per commit: red if anything there is uncovered, amber if anything is only partly covered, nothing otherwise.
- The page header shows the branch figure, "Changed lines covered 84%".
- A **Coverage** toggle in the page header, also on `g`, hides every mark and chip. It is on by default once data exists, and the choice is remembered per browser.

Navigation. `x` jumps to the next uncovered added row and `X` to the previous one, in document order across commits. Like VS Code's uncovered-block navigation, it scrolls the row to 30% from the top, flashes it, and expands a Viewed (collapsed) commit while it is shown.

Clicking a mark opens a popover, borrowed from IntelliJ:

- On a covered row: "Hit 14 times", plus the branch hits for a partly covered row. With per-test detail, it adds "Run by 3 tests" and lists each test id. A test whose `--at` location (or a `path::name` id) lies in the branch links into the document with the Back chip. Otherwise it opens the existing peek. Without per-test detail it says "No per-test detail in this run".
- On an uncovered row: "Not run by the suite at b164dd3 (2026-10-22 14:05)", with a **Flag as missing test** button. That opens the Flag box under the row with kind `missing-test` preset.

Staleness. A new plan version does not stale coverage, because reordering commits never changes the tip. Only a moved tip does:

- On a tip move, files unchanged between the old tip and the new one keep their marks.
- Files that changed show hatched marks and "coverage from b164dd3; this file changed since". The header chip reads "Coverage is 2 files stale".
- `next:` in the bare entry tells the agent to run the suite again.

### 10.2 Offers

What an offer is. An offer is the agent saying "I can draw this for you". It is neither an opinion about the code (a concern) nor a question. The agent writes offers in the plan, because that is when it has read the code, as `offers` on a commit or unit ref, for example `{ "kind": "state-machine", "label": "Draw UploadButton as a state machine" }`. Validation derives an `o_` id.

Placement and limits:

- A commit offer sits under the commit message, after the Agent's note. A unit offer sits above its hunk, after the unit narration.
- There are none in the index (they would only add noise there) and none in the page header.
- At most one offer per commit and three per plan, enforced by `check` as errors.

Visual:

- A single-line chip with a dashed border, a diagram icon and muted text: "Agent can draw: UploadButton as a state machine". It has an **×** on the right.
- Concerns are filled cards with a severity colour, and questions are blue cards. An offer is never a card until it is accepted.
- Following GitHub's dismissable annotations, **×** dismisses it in place, with no reason asked because it is only a suggestion. It is stored and stays dismissed across versions.

On click:

1. The chip becomes a thread card at the same place. It posts a reviewer comment `{ kind: "question", offer: "o_…", body: <label> }` through the normal `api/comments`, so `watch`, the bare entry and the report all see it with no new path.
2. The card shows "Waiting for the agent…" with a pulsing diagram placeholder at the full width the diagram will take.
3. `watch` prints "Reviewer accepted offer o_… on src/upload.tsx:12-60 (commit 4): Draw UploadButton as a state machine. Reply with `follow-me reply <cid> --diagram <file> [--map <file>]`."
4. The reply lands under the card like any reply, with its diagram inline and the lightbox on click.

An offer that is dismissed or answered never shows as a chip again. If the agent never answers, the card stays "Waiting" and the bare entry's `next:` keeps naming it.

### 10.3 The state machine view

Where it lives. It is the accepted offer's reply: inline at full width in the thread card under the commit or above the hunk, at most 480px tall at 1280px and 360px at 1024px, with the lightbox for detail. There is no separate panel (section 9).

Rendering. Mermaid `stateDiagram-v2` draws the picture. It cannot provide the clickability or the marks: under `securityLevel: "strict"` Mermaid disables click callbacks, and its `click` directive is a flowchart feature. So:

- The reply carries a sidecar `map`, which ties each state, and each transition where possible, to code on the tip.
- After Mermaid renders, the page finds each state's node in the SVG by its name (Mermaid's state node ids embed the state name; this is to be verified against the vendored version). It then adds `role="button"`, a tabindex, a click handler and a coverage class.
- Matching edges in the SVG is fragile. So a transition table under the diagram is always shown: From → To, event, coverage, jump. It is also the accessible path to every state and transition.
- If a state name cannot be matched in the SVG, its row in a matching "States" table still works. Nothing depends on parsing Mermaid's output.

Clicking a state or transition:

- It reuses the definition jump: the target rows are scrolled to, flashed, and the Back chip returns to the diagram.
- A state whose code spans several commits opens the definition list-of-places popover ("Uploading: commit 2 src/upload.tsx:30-41 · commit 5 :88-95").
- Code the branch does not change opens the peek.

Coverage marks are derived only from lcov over the mapped lines, never from the agent's claims:

- covered: every executable mapped line hit;
- partly covered: some hit, or a mapped branch only partly taken;
- not covered: none hit;
- unknown: no coverage data, nothing executable, or stale.

In the SVG, covered is a solid green outline with a small ✓ badge, partly is an amber dashed outline with a half-filled badge, not covered is a red double outline with a ✕ badge, and unknown is the plain Mermaid style. A legend row sits under the diagram ("✓ covered · ◐ partly · ✕ not covered · plain unknown · from tests at b164dd3"). With per-test detail, hovering or focusing a state lists the tests that reached it.

Dark mode and 1024px. The Mermaid dark theme is already chosen from `prefers-color-scheme`. The outlines and badges use the same CSS variables as the gutter, so they keep 3:1 against both themes, and every mark has a shape as well as a colour. At 1024px the diagram is 992px wide and fit to width, and the tables wrap their location column under the state name. Anything denser is read in the lightbox, which keeps the clicks and marks because it renders the same post-processed SVG.

### 10.4 What the agent is told

The skill's "Offers" section:

> Offer a diagram only when a picture would save the reviewer real reading: a component or module with an explicit status or mode and several transitions (a state machine), a request crossing three or more modules (a sequence), or a non-obvious data flow. At most one offer per commit and three per plan; most plans need none. Label it with the thing, not the type: "Draw UploadButton as a state machine". When `watch` says an offer was accepted, run the test suite with coverage at the tip first and pass it with `follow-me coverage`, then reply with `--diagram` (Mermaid stateDiagram-v2) and `--map`, tying every state and transition to tip path and lines. Never describe coverage yourself; the page derives it.

The skill's "Coverage" section:

> When a review opens and the project has a test command, run it with coverage at the tip and pass the lcov to `follow-me coverage`. Add per-test detail when the tool gives it cheaply, then pass `--test` and `--at` so tests in the branch are linkable. Do this again after the tip moves.

### 10.5 Wire changes, effort and build order

All of these are optional and change no existing hash:

- Plan: `offers?: { "kind": "state-machine" | "sequence" | "diagram", "label": string }[]` on a commit and on a unit ref object. Ids are derived as `o_` plus 8 hex.
- `Comment.offer?: OfferId`, set on the comment that accepts an offer.
- `Reply.map?: { "states": { "<name>": Loc[] }, "transitions"?: { "from": string, "to": string, "event"?: string, "at": Loc[] }[] }`, where `Loc = { "path": string, "start": number, "end": number }` in tip lines. `follow-me reply` gains `--map <file>`.
- `Review.dismissedOffers?: OfferId[]`.
- A new session file, `coverage.json`: `{ tip, takenAt, files: { <path>: { lines: { <n>: hits }, branches?: { <n>: [taken, total] } } }, tests?: { <id>: { at?: Loc, lines: { <path>: number[] } } } }`. Add a `coverage` event `{ tip, takenAt }`, and serve the data from `api/coverage` rather than `api/state`, so state stays small.

Effort:

- `follow-me coverage`, lcov parsing and the tip check: M.
- Gutter marks, summaries, toggle and `x`: M.
- The click popover with hits: S. Per-test detail with links: M.
- Staleness on a tip move: S.
- Offers in the plan, the chip, the accept-as-comment flow, dismiss and the `watch` text: S to M.
- `Reply.map`, SVG post-processing, the tables and the state marks: M to L.

Build order, cheapest valuable first:

1. `follow-me coverage` with aggregate lcov, plus gutter marks and the commit chip.
2. `x` navigation, the toggle, file and index summaries, and the hit popover with Flag as missing test.
3. Stale marking on a tip move.
4. Offers, generic for any diagram, reusing threads.
5. Per-test detail and test links.
6. State-machine maps with clickable states, the transition table and coverage marks.

Stop after step 3 and watch real reviews before building steps 4 to 6.

## 11. Path coverage and replies that point at code

This section was written against `b9ad1f1` (v0.8.0). Coverage there is per line and per branch from lcov, the state machine view marks states from the lines they map to, and a reply is markdown with an optional diagram and a state map. The constraints of section 10 still hold: follow-me never runs tests and never calls a model, and coverage is evidence only when it comes from a real run.

Recommendation up front: build transition coverage first, because the state map already ties edges to code and the reviewer already looks at it. Build replies that point at code in parallel, because they need no new data from the test run. Build the per-hunk paths panel last.

### 11.1 What a path is, given what lcov can say

- The agent runs the tests one at a time with coverage and passes each run with the existing `follow-me coverage <lcov> --test <id> [--at <path:line>]`, or passes one lcov with `TN:` blocks. No new flag is needed.
- What changes is what follow-me keeps per test. Today `tests.<id>` keeps the lines it hit. It also keeps the `BRDA` outcomes with their counts, and the `FN` records so decisions can be grouped by function: `tests.<id>.branches: { <path>: { <line>: number[] } }`, one count per branch id.
- One test's run through one function is a path: the outcome it took at each decision of that function, or "not reached". Decisions are the `BRDA` lines inside the `FN` range.
- lcov gives a set of outcomes per test, not an ordered trace. Two consequences, both stated in the UI rather than hidden:
  - A test that takes both outcomes of one decision (two calls, or a loop) shows "both" in that cell, and it does not close a gap whose pairing depends on that decision. The panel says "pairing unknown".
  - Loops use the counts: the outcome that enters the body is shown as 0, 1 or many times. A loop never contributes more than those three cells.
- Gaps are not the cross product of outcomes, which grows as 2^n and is mostly impossible combinations. A gap is a one-flip neighbour of a tested path: the same outcomes up to some decision, then the outcome no test took after that prefix. That lists at most one gap per decision per tested path, and nearly all of them are reachable.
- Outcome labels come from the source line, not from branch ids: the decision is named by its trimmed code (`items.length === 0`), with yes and no for two-way branches, and "case 2 of 4" for switches. Branch 0 is taken as "yes" for `if`, ternaries and `&&`; verify this against istanbul and c8 output on the fixture before relying on it.

### 11.2 Transition coverage on the state machine view (first)

A transition is covered by a test when that test hit every executable line in its `at`. The skill tells the agent to map each transition to the line that performs it (the assignment or dispatch), not to the condition that guards it. A transition with an empty `at` is unknown.

On the diagram:

- Covered edges: solid green, with a small count badge at the label ("2" tests). Uncovered edges: red, dashed, with a ✕ badge. Unknown edges keep the plain Mermaid style. Edges are matched in the SVG by their label text where they can be; the transition table stays the source of truth (10.3).
- State marks stay as in 10.3. A state now counts as covered only when it is both reached and left by some tested transition, or is final.
- Hovering or focusing an edge lists its tests. Clicking it jumps to its `at` rows with the Back chip, as states already do.

The transition table gains a **Tests** column: up to two test names as chips, then "+3". Uncovered rows sort first.

Never-driven sequences, under the legend, as a list titled "Not driven by any one test":

- Candidates are simple paths from the initial state to each final state, up to 5 transitions, with each cycle taken at most once.
- A sequence is driven when one test covers every transition in it. With per-test sets this means "covers every step", not "in this order". For a state machine that is close enough, and the list's tooltip says so.
- Only sequences whose every edge is covered by some test are listed. A sequence with an uncovered edge is already shown by that red edge, and listing it again is noise. This is the interesting case anyway: each step has a test, but no test goes through them together.
- At most three are shown, shortest first, then "+N more". Each row reads `Idle → Loading → Failed · each step tested, never in one test`, with **Show** (outlines the path on the diagram in a red dashed overlay while hovered or focused) and **Flag as missing test** (opens the Flag box under the diagram with kind `missing-test` and the sequence as its body).

### 11.3 Paths per hunk

Where it lives:

- Not in the gutter. The gutter keeps its one 3px bar, and a decision row that has a gap keeps the amber half-bar it already gets from `BRDA`. Path data would need a second mark there, and it would be noise next to every `if`.
- The hunk header gets a chip on the right, only when the enclosing function has gaps: "Paths 3 tested · 2 untested". It is muted when nothing is untested, and absent with no per-test data.
- Clicking the chip, or `p` with focus in the hunk, opens a **Paths** panel docked under the hunk, inside its card. It is closed by default, so top-down reading is not interrupted. Its open state is remembered per hunk.
- The commit chip adds "· 2 paths untested" after "18/24 covered", and the index dot already turns amber.

The panel:

- One column per decision in the function, headed by its line number and trimmed code. Decisions on rows this commit changes are in bold. With more than five decisions, the ones outside the hunk collapse into "+4 decisions outside this hunk", and paths are deduplicated over the remaining columns.
- Tested paths first: one row each, with cells ✓ yes, ✕ no, · not reached, both, or 0/1/many for a loop, then the tests that took it (two chips, then "+N"). A test chip links like the coverage popover's test links do.
- Then a divider, "Untested", and the gaps: the same cells, with the flipped cell outlined in red, and two actions, **Go to line** (focuses the decision row where the gap diverges and flashes it) and **Flag as missing test** (preset box under that row).
- Hovering a row tints the decision rows of the hunk it passes through and greys the rows it skips, so the path can be read in the code itself.

### 11.4 Keyboard

- `x` / Shift+X keep their meaning, extended: the next or previous gap of any kind, in document order. A gap is an uncovered added row or an untested path. On a path gap, the hunk's Paths panel opens with that row focused and the divergence row flashes. A path gap whose divergence row is itself an uncovered row counts once.
- `p` opens or closes the Paths panel of the hunk in focus. In the panel ↑ and ↓ move between rows, Enter is Go to line, and `f` is Flag as missing test.
- `g` still hides every coverage mark, and with it the paths chips, panels, edge marks and the sequence list.

### 11.5 When the data is per line only

- No per-test runs (an aggregate lcov): there are no Paths chips and no sequence list. Edges are covered when their `at` lines ran, with no test names, the same rule as states. Partly covered decision rows keep the amber bar, and their popover keeps "2 of 4 branches taken". One muted line sits under the legend and in that popover: "Paths and sequences need one coverage run per test." with an **Ask the agent** link that posts that request as a question, so the ask goes through the normal thread loop.
- Per-test lines without `BRDA` (some Go and Python setups): edges get tests, sequences work, and the Paths panel says "This run has no branch data" instead of opening.
- Stale files (10.1) show no paths and no edge marks for those files, only the hatched marks.

### 11.6 Replies that point at code

How a reply refers to code. The agent writes refs as inline code spans, in the grammar `follow-me show` already reads, extended to ranges: `` `src/checkout.ts:42-48` `` for tip lines, `` `src/checkout.ts:42-48@5` `` for the lines as commit 5 writes them, and `@base` for base lines. Only a code span that is entirely a ref counts. Prose such as "at 10:30" and code spans like `` `items.length` `` never become refs.

- The page numbers refs in order of first appearance, 1, 2, 3, and renders each as a chip: a small filled number badge, then `checkout.ts:42-48`, then "commit 5" in muted text when the ref sits in a commit other than the reply's own. A repeated ref reuses its number.
- A reply with two or more refs is a walkthrough. No flag marks it. If a list item holds a ref, its text becomes that step's caption.
- The reply card keeps its look, with one addition: a muted line under the agent label, "3 places · press Enter to step through".

What the code does:

- When a reply card is hovered or focused, every row of every ref gets a light violet tint, the agent's colour, distinct from the yellow pick and the green and red diff. The first row of each range gets a number badge in the gutter, in the space of the hover `+`, and a 2px violet bar runs down the range. This lasts only while the card is hovered or focused, so the code is never left painted.
- Hovering one chip makes its range stronger and fades the others.
- A ref that is off screen shows ↑ or ↓ on its chip. Hovering it opens the existing peek, showing the lines with the same tint and badge, so the reader can glance at it without leaving.
- No connector lines. They break on scroll across a long document and cross other code.

Click to jump:

- Clicking a chip pushes one departure and scrolls the range to 30% from the top with a flash, as the definition jump does. The Back chip reads "Back to the reply", and Alt+← returns.
- Starting a walkthrough (Enter on the card, or clicking any chip) shows a step bar pinned to the bottom of the code column: "Agent's walkthrough · 2 of 4 · checkout.ts:42-48 · ‹ › · Esc", with the step's caption. The current step's range keeps the strong tint while the bar is up, and the others keep the light one.
- `.` goes to the next step and `,` to the previous one. Esc ends the walkthrough and clears the tints. Alt+← returns to the reply, wherever the walkthrough had got to. The walkthrough pushes one departure, not one per step, so Back is a single hop.

Where the code sits:

- In a Viewed (collapsed) commit: the commit opens while the step is shown and collapses again when the walkthrough ends, as `x` does.
- In a fold row ("4 lines arrive in commit 5"): a tip ref resolves to the commit that writes the line, the same rule definitions use, so it lands in commit 5, not on the fold. The chip says "commit 5".
- In a later commit: it jumps there. Reading ahead is fine for an answer, and the chip's "commit 5" says where it goes before the click.
- Outside every hunk (code the branch does not change): the chip opens the peek instead of jumping.
- An `@base` ref highlights removed rows when they are shown, and otherwise opens the peek with the base lines.

Over time. The server resolves refs when the reply is posted and stores, beside the body, `Reply.refs?: { n, path, start, end, at: number | "base" | null, quote: string[] }[]`, quoting at most eight lines as comments do. A new plan version re-resolves tip refs, which stay valid because the tip did not move. An `@n` ref whose lines moved re-resolves through the tip lines when it can, else its chip turns grey and shows the quote. When the tip moves, the chip says "from b164dd3" and the peek shows the quote.

The CLI. There are no new flags. `follow-me reply` and `follow-me explain` parse refs out of `--body` and refuse a ref that does not resolve, listing every bad one at once ("src/checkout.ts:120 is past the end of the file at the tip (88 lines)"), like `--map`. `follow-me show` accepts `path:start-end[@n|@base]`, so the agent can check a ref before it sends it. The skill adds one paragraph:

> When an answer depends on specific code, point at it: write `path:start-end` (tip lines) or `path:start-end@<commit>` as inline code, and the page turns it into a numbered chip that highlights and jumps. For an explanation in steps, write a numbered list with one ref per item. Check a range with `follow-me show` first.

State maps stay as they are. Clicking a state uses the same tint and badge (the badge holds the state's initial), so there is one way of pointing at code.

### 11.7 Rejected alternatives

- Full cross product of outcomes as gaps: it grows as 2^n, and most combinations are impossible.
- Requiring true execution traces from the agent (a new `--trace` format): it would mean instrumenting each runtime. lcov per test is enough to start; add traces only if "pairing unknown" proves common.
- Path marks in the gutter: a second mark beside every `if` makes coverage the loudest thing on the page.
- A separate Paths view or tab: it breaks top-down reading, and gaps belong next to their hunk.
- Paths panel open by default: it doubles the height of every hunk with a decision.
- Listing never-driven sequences that contain an uncovered edge: the red edge already says it.
- A new `--ref` flag or a JSON refs file for replies: refs inside the prose keep the explanation and the pointer together, and the agent already writes `path:line`.
- Bare `path:line` in prose as refs: false positives such as times and URLs.
- Connector lines from the reply to the code: they break on scroll across commits.
- Persistent highlights after the reply loses focus: the code ends up painted by old answers.
- Arrow keys for steps: they already move between rows, and Alt+← is Back.

### 11.8 Build order

1. Keep per-test `BRDA` counts and `FN` in coverage.json (S). Skill text for one run per test and for mapping transitions to the performing line (S).
2. Transition coverage: edge marks, the Tests column and the hover list (M).
3. Refs in `reply` and `explain`: parsing, validation, `Reply.refs` with quotes, and ranges in `show` (S to M).
4. Ref chips, the hover tint and badges, click to jump with Back, and Viewed and later-commit handling (M).
5. The "Not driven by any one test" list with Show and Flag (S to M).
6. Walkthrough stepping: the step bar, `.` and `,`, and captions (S).
7. The Paths chip and panel, the `p` key, and `x` across path gaps (M to L).
8. The per-line-only fallbacks and Ask the agent link (S).

Stop after step 5 and watch real reviews before building the Paths panel. Transition coverage may answer most of the "which paths are untested" question on its own.
