# Design

follow-me splits a branch's net change into fine, ordered commits that read like
the author's thought process, lets a human review and comment hunk by hunk, and
hands the review back to a coding agent for the next plan version.

## The one idea that removes patching

Every unit comes from a single `git diff base..tip`. Hunks of one file are
disjoint in base coordinates, so a file's content after applying any subset of
changed lines is the base lines with the chosen `-` lines dropped and the chosen
`+` lines inserted. Order of assignment never matters and nothing can misapply.
There is no offset search and no fuzz. Two gates stand instead:

1. While parsing, every context and `-` line must equal the base blob at its
   position. A mismatch is a parser bug and aborts.
2. After projecting the last commit, every path's bytes and mode must equal the
   tip. Then git's own tree hash is compared once more after writing.

## Units

- `h_…` text hunk. The planner may take all of it, or a subset of its change
  lines (`h_x:0-3,7`). Every change line is used exactly once across the plan.
  A bare `h_x` takes whatever lines of that hunk no other commit claimed.
- `f_…` whole-file unit for content that cannot be projected line-wise: binary,
  symlink, gitlink, empty create or delete, type change.
- `m_…` mode flip of a text file present on both sides.

Ids are `prefix_` plus twelve hex of sha256 over path and hunk body without line
numbers, so moving the tip or re-extracting keeps ids of unchanged hunks.
Identical duplicates get `~2`, `~3` in diff order.

File existence per commit is derived from which change lines are applied, so
there are no separate create and delete units for text files.

## Plan, validation, apply

`validatePlan(diff, draft: unknown)` is pure and returns every issue at once or a
`ValidPlan` that carries each commit's projected tree changes. Only `plan.ts`
can construct a `ValidPlan`, so an unvalidated plan cannot reach the writer.

`writeBranch` builds commits with a temporary index file and `commit-tree`,
never touching the user's index or working tree. Author and committer come from
the tip commit and commit `i` of `n` gets committer time `tipTime - (n - 1 - i)`.
The branch ref moves only if it still points where the last apply left it.

Commits are signed when `git config --type=bool commit.gpgsign` is true; `--sign` and
`--no-sign` override it. `commit-tree` is plumbing and ignores `commit.gpgsign`, so apply
reads it and passes `-S` or `--no-gpg-sign`; `gpg.format` and `user.signingkey` then apply
as they do for `git commit`. SHAs are stable only when signing is off: openpgp, x509 and ecdsa
signatures differ on every run (ssh ed25519 happens to be deterministic). So the branch record
is what makes re-apply a no-op either way. `applied.json` stores the plan version, its hash,
the branch, its head and whether it was signed; when all match and the branch still points at
that head, apply writes nothing and prints `unchanged`. Otherwise `writeBranch` runs, and an
unsigned rewrite that yields the head the branch already has is `unchanged` too.

The split never lands on the branch being split, and never on a branch checked out in any
worktree, `--force` included; `--force` only lets apply move a branch follow-me did not create.
New blobs, trees and commits go to a quarantine directory inside the object store
(`GIT_OBJECT_DIRECTORY`, with the real store as an alternate) and are hard-linked in right
before `update-ref`, so a refused or failed apply leaves no refs and no objects.

### Syntax gate

A sliced commit may fail to build or pass tests, but every file it writes should still parse.
After validation, `check` and `apply` hand each `write` change of each commit to a checker chosen
by extension and run on a temp file with the projected bytes: `node --check` for `.js .mjs .cjs`,
`module.stripTypeScriptTypes` in a child node for `.ts .mts .cts` (`node --check` does not strip
types, so it rejects valid TypeScript), `JSON.parse` for `.json`, `sh -n` or `bash -n` for
`.sh .bash` (bash when the shebang or extension says so), and `python3 -m py_compile` for `.py`.
Everything else is skipped and counted, as is a checker whose program is not installed; `.jsx`,
`.tsx` and yaml have no parser here. `--syntax "<command with {file}>"` replaces the table for every text
file. Checks run four at a time and identical bytes are checked once. The last commit equals the
tip by construction, so it is checked once and a failure there is reported as the tip's own state;
that file is then not checked in earlier commits, where the failure would be blamed on the split.
Any other failure prints as `commit <n>: <path>: <message>`, with commits counted from 1 as in every
issue `check` prints; `check` exits 1 and `apply` refuses
unless `--allow-syntax-errors`. The gate reads only the `ValidPlan`, so it adds no git calls.

## Review loop

`.follow-me/<branch-slug>/` holds `session.json` (the anchor), `draft.json`
(planner output), `plans/vN.json` (frozen on apply, deduplicated by hash),
`reviews/vN.json` (written once when a review ends), `reviews/vN.draft.json` (autosave of an
unfinished review), `applied.json` and, while apply runs or the review server hosts the session,
`lock`.
One writer per file.

Comments anchor to `(commit index, unit id, optional change lines)`, a commit
message, a commit position, or the whole plan, and snapshot the message and path
they pointed at. A comment is answered when a later plan lists it in
`responses`; nothing is stored on the comment. Unanswered comments are warnings,
not errors, so a human can still apply.

Two planners write the same draft format. An agent reads `follow-me prompt`
and writes `draft.json` itself; follow-me never calls a model. `follow-me plan --naive`
needs no agent: one `wip: <path>` commit per touched file in diff order, so the pipeline runs on a
real branch with no planner. `scripts/dogfood.sh` runs it on this repo's last commits in CI.

## Many sessions

State is split so concurrent sessions share nothing they write.

- `.follow-me/` sits at `git rev-parse --show-toplevel` of the cwd. In a linked worktree that is
  the worktree itself, not the main checkout, so each worktree has its own `.follow-me/` and its
  own `.gitignore` in it. Two repos are two roots.
- Within a root, each branch has its own `<slug>/` directory. Slugs map `/` to `-`, so `a/b`
  and `a-b` would collide; `session.json` names its branch, and the second branch is refused.
- The only thing worktrees share is the repo: refs and the object store. Split branches are
  `<branch>-split` per session, so two worktrees write different refs, each by compare-and-swap.
  Objects are content-addressed and adopted with link, which never overwrites.
- Two agents on the same session is the one real shared writer, so apply, review and walk hold
  `<slug>/lock`, and the review server holds it for as long as it hosts the session. The lock is written whole to a temp file and linked into place, which fails
  like `open(wx)` when it exists. It records the pid; a lock whose pid is dead is taken over, and
  release removes it only if it still carries this process's token.
- Every session of a user shares one review server; see the next section.

`follow-me clean` converges a root to what live sessions need. It removes sessions whose branch
is gone, review drafts at or below the latest finished review, and locks, `*.<pid>.*.tmp` files
and object quarantines whose pid is dead. Plan versions stay; reviews refer to them. `--all`
removes `.follow-me/` and refuses while a live process holds a session.

## One server, many sessions

A user runs one review server, and it hosts every session they are reviewing, across repos and
worktrees. Its record lives in a per-user state dir, `$FOLLOW_ME_HOME`, else
`$XDG_STATE_HOME/follow-me`, else `~/.local/state/follow-me`, as `server.json`
(`{ pid, port, startedAt }`), with `server.log` beside it for a detached server's output. The
record is claimed like the session lock, by linking a complete temp file into place, so two
servers starting at once cannot both own it; the loser closes and attaches to the winner. A
record whose pid is dead or does not answer as ours is replaced.

The server keeps a registry, `Map<SessionId, HostedSession>`. A `SessionId` is 12 hex of sha256
over the session directory, so registering the same session again returns the same id and URL
instead of a second copy; registering it with another plan version is refused until the first
review ends. Each session is served at `/s/<id>/` with its API under `/s/<id>/api/`. `/` lists
every session with its repo, branch, mode, version and comment count, `/api/sessions` returns
the same list as JSON, and `/api/health` answers `{ "app": "follow-me", "pid" }` so a CLI can tell
our server from another program on the port.

`review` and `walk` prepare the plan under the session lock, then find the server: a live
`server.json` record, or a `--port` that answers as ours. If one runs, the CLI registers the
session with `POST /api/sessions` (session dir, mode, version, plan hash, lock token), prints the
URL and exits. Otherwise the CLI becomes the server in the foreground and waits for its own review
to end, or with `--detach` starts `follow-me server run` as a detached process and registers with
it. The registration carries the CLI's lock token and the server takes the lock over by token
before the CLI lets go, so exactly one live process owns a hosted session's lock and there is no
gap for another to take it. Running `review` again while the server holds the session prints the
same URL.

Ending a session writes `reviews/vN.json` exactly as a single review always did, removes the draft
and releases the lock. The server exits on its own once it has hosted no session for 30 seconds
(`FOLLOW_ME_IDLE_MS` overrides this, for tests), so a review started right after another reuses it.
`follow-me server stop` sends SIGTERM to the recorded pid, but only if that pid answers as our
server on the recorded port. On SIGTERM or Ctrl-C the server releases every lock and writes no
review; autosaved drafts come back when the session is opened again. It removes `server.json` on
every exit.

A `--port` held by our own server means attach. Held by anything else, the server listens on a
free port and the CLI prints `port N is in use by another program, using M`. Binding never fails
with EADDRINUSE.

## Reviewer mode

The same engine serves a second persona, chosen by whether a split branch was applied for the
session: after `apply`, `follow-me review` is the author's review of their own plan; without it, it is
a reviewer meeting someone else's branch. The reviewer reads the commits in order and comments on the
code. Nothing is applied and no branch is written. `walk` is an old name for `review`.

A reviewer's plan has no new format. A commit and any unit ref may carry `narration`, which the page
shows as the agent's note, and validation passes it through to `ProjectedCommit`. A unit entry with a
note serializes as `{ "unit": "h_x:0-3", "narration": … }`; without it the entry stays a plain string,
so older plans and their hashes are unchanged. Both prompts carry the same session data and name the
same skill section; the section says what each mode is for, and reviewer mode adds a note only where
it adds to the commit body, and concerns.

A commit may carry `section`, one of `story`, `steps`, `details` or `wiring`, naming the top-down rule
that put it there, so the page can group commits under it. Any other value is a `malformed` issue. It
serializes right after `message` and only when present, so plans without it keep their hash, and
validation copies it to `ProjectedCommit.section`.

`Review.mode` is `split` or `walk` (the wire name of the reviewer's mode), and a file without it reads
as `split`. A reviewer's review is a code review for the author, not plan feedback, so `lastReview`
ignores it: its comments never reach the planner as comments to answer. Every review, of either kind,
is written to `reviews/vN.json`, so one plan version gets one review. Older builds wrote reviewer
reviews to `reviews/walk/vN.json`; those are still read (`feedback --walk`, `status`).

## The review page

The page is a thin DOM shell (`ui/app.js`) over pure functions in `ui/playback.js`, which tsc
checks and `test/playback.test.ts` covers. Anything a test can state as data lives there.

Playback is a chunk stepper. `buildScript` turns the projected commits into beats: per commit an
intro, one chunk per run of its own change lines inside one unit (at most three other lines between
two change lines, cut to twelve lines, preferably right after a blank or closing line), one chunk
per whole-file or mode unit, and an outro. A unit's narration goes on its first chunk. `schedule`
turns beats into timed steps at a speed: a say step shows the narration card and speaks it, a show
step reveals the chunk, a rest follows each chunk and a hold ends each commit. Reading time is
`max(2000, 1000 + 300 per word)`, code time `clamp(1500 + 400 per non-blank added line + 200 per
removed line, 2000, 9000)`, the rest 600ms and the hold 2500ms, all divided by the speed. A say step
lasts its reading time or until speech ends, whichever is later. A commit without narration speaks
its title and stays up long enough to read its whole message; a chunk without narration shows a
generated label such as `src/lib.js · adds 2 lines in mul` and says nothing. Only one utterance
exists at a time: every speak cancels the last, and every move retires the running loop by
generation. The position is a step index, and every line's look is a pure function of it, so
seeking, pausing and re-rendering never disagree.

A hunk reads as it stands in its commit (`rowsOf`). The commit's own lines are the change, removals
struck through. Lines earlier commits added are context, lines they removed are gone. Lines later
commits remove are context, and lines later commits add fold into one row per run that links to
their commit. The gutter shows base and tip line numbers (`lineNumbers`), computed from each hunk's
base start shifted by earlier hunks of the file. Comments still anchor to change indices on the
wire and are displayed by tip line number (`describeLines`).

A commit and any unit may carry `diagram`, Mermaid source, beside `narration`. It parses like
narration, and `parsePlanFile` rejects one whose first line does not name a Mermaid diagram type.
The page draws the commit's diagram in a side panel and swaps to a unit's while playback is on that
unit (`diagramAt`). The server serves Mermaid's ESM entry from `node_modules` at
`/vendor/mermaid.mjs` and its chunks beside it, because the ESM build imports them by relative
path. The page imports it only when the plan has a diagram, and shows Mermaid's error text in the
panel when a diagram does not render.
Playback is a script of steps built from the projected commits: a commit begins (its narration,
else its title, is spoken), each unit begins (its narration is spoken and waited for), then each of
the commit's own change lines appears or fades out. The UI holds a position into that script, and
every line's look is a pure function of the position (`ui/playback.js`), so seeking, pausing and
re-rendering never disagree. Speech uses the browser's `speechSynthesis`; muting keeps the timing
without audio, and a timeout bounds engines that never report the end of an utterance.

## Definitions

`GET /s/<id>/api/definition?name=&from=` answers `{ candidates }`, where `Candidate` is in
`src/types.ts`. `name` must be an ASCII identifier, else 400. `src/definition.ts` holds one table of
definition patterns per language, chosen by file extension: JS and TS, Python, Go, Rust, Java and
Kotlin, Ruby, C and C++. Each pattern is written in the subset that JS regexes and POSIX ERE read
alike, so the same text is the `-e` of one `git grep -n -E -I -z` over the tip commit (never the
working tree) and the filter that keeps a match only when a pattern of its own file's language
matches it. A few patterns also carry a JS-only `reject` for statements that look like a definition
without lookahead, such as `return parse(s)` in Java.

A match whose tip line is a row of one of the plan's hunks gets that `unit`, the body `row`, and the
0-based `commit` that writes the row; for a context row that is the first commit taking the unit.
Anything else gets nulls and a `preview` of up to 8 tip lines, read with `cat-file --batch`. The page
reads an in-plan definition from its hunk, so the server sends its preview empty; `follow-me show`
prints it either way. Candidates rank by the asking file, then its directory, then the rest, in grep
order, at most 10. Matches are cached per name and file lines per path in the hosted view, which a
version swap replaces, so the cache never outlives its tip.

## Coverage

follow-me never runs tests. The agent runs the project's suite with coverage at the branch tip and
hands the lcov over with `follow-me coverage <lcov> [--test <id> [--at <path:line>]]`, which writes
`.follow-me/<slug>/coverage.json` atomically:
`{ tip, takenAt, files: { <path>: { lines: { <n>: hits }, branches?: { <n>: [taken, total] },
functions?: { name, start, end? }[] } }, tests?: { <id>: { at?: Loc, lines: { <path>: number[] },
branches?: { <path>: { <n>: number[] } } } } }`, with `Loc = { path, start, end }` in tip lines.
A test's `branches` holds one count per `BRDA` branch of the line, in lcov's order, so a later
reader can tell which outcome each test took at each decision; `functions` are the `FN` records. `src/coverage.ts` holds the parser, the merge and the counts; `session.ts` owns the file.

- **Parsing.** `TN`, `SF`, `DA`, `BRDA`, `FN` (`<line>,<name>`, or lcov 2's `<start>,<end>,<name>`)
  and `end_of_record` are read; every other `KEY:` record is skipped. A line that is not a record, a
  bad `DA`, `BRDA` or `FN`, a hit before any `SF` and a file with
  no `SF` are errors that name the line. Records of one file are summed, and a branch counts as taken
  when any record took it, so `[taken, total]` is per line over distinct branch ids.
- **Paths.** An `SF` path is absolute, else relative to the cwd and failing that to the repo root,
  with symlinks resolved, then made repo-relative. A path outside the repo, or one the tip's tree
  lacks (generated files, node internals), is dropped. When nothing is left the command refuses and
  says to run it from where the tests ran.
- **The tip check.** Lines are only tip lines if the files were the tip's when the tests ran, so a run
  is refused with "coverage must be taken on the tip; these files differ: …" when any covered path
  differs between the working tree (or index) and the tip, by `git diff --name-only <tip>`.
- **Runs.** A plain run replaces the whole file; its `TN:` blocks, when named, become `tests`. A
  `--test` run adds one test (its lines with a hit, `at` from `--at`) and folds its hits into `files`
  by the larger count, so a per-test run never inflates an aggregate one and repeating it changes
  nothing. A `--test` run against another tip starts over.
- **Changed lines.** The summary line counts the branch's added rows that the run calls executable,
  that is rows with a `DA` record, and how many were hit: "coverage for N files at <tip>; M of K
  changed lines covered".

The server serves the file at `GET api/coverage` (404 before the first run), read from disk on every
request so a restarted server has it, plus `stale`: the covered paths whose content differs between
`coverage.tip` and the hosted tip (all of them when that commit is gone). A new plan version for the
same tip reorders commits but changes no line, so it stales nothing, and a swap never touches the file.
When the session is hosted, `follow-me coverage` posts `api/coverage` and the server emits
`{ type: "coverage", tip, takenAt }`; the page reloads its marks from `api/coverage`, and `api/state`
stays small. The event is the agent's own act, so `watch` and the entry do not print it.

The bare entry mentions coverage once: its launch output says to run the tests with coverage when the
session has no `coverage.json`. The report uses only files that are not stale: the markdown adds
"coverage: M of K changed lines" under each file heading, and `report --json` gives each flag and kept
concern over added rows `covered`, true when every executable added row it points at ran.

## Offers and state maps

An offer is the agent saying "I can draw this for you". It is neither a concern nor a question, and
it is written in the plan, where the agent has just read the code: `offers: [{ kind, label }]` on a
commit or a unit ref, with kind one of `state-machine`, `sequence`, `diagram`.

- **Ids.** Validation gives each offer `o_` plus 8 hex of sha256 over its unit (empty for a commit
  offer) and its label, so a re-plan that moves the same offer to another commit keeps its id. Two
  offers with the same id are a `bad-offer`. `ProjectedCommit.offers` lists the commit's own first,
  then those of its unit refs with `unit` set. A plan without offers serializes as before and keeps
  its hash.
- **Limits.** `check` refuses more than one offer in a commit (its unit refs' included) and more than
  three in the plan, as `too-many-offers` with the commit, or with `commit: null` for the plan.
- **Accepting.** The page posts a reviewer question with `offer: <id>` through `api/comments`, so
  `watch`, the entry and the report see an ordinary question. The server refuses it with a 400 when
  the id is not in the open plan, or another comment of the same review (this version or a carried
  one) already accepted it, or it was dismissed; a `PUT` cannot change a comment's offer. Deleting
  the accepting comment opens the offer again.
- **Dismissing.** `POST api/offers/<id>/dismiss` (no body) adds it to `dismissedOffers`, emits
  `{ type: "offer-dismissed", offer }`, and is saved in the draft and the review; again is a no-op,
  an accepted offer is a 400 and an unknown one a 404. A swap carries `dismissedOffers` whole, and
  `api/state` sends it, so a later version of the same review never shows either kind as a chip:
  accepted ones are found by `offer` on `comments` and `carried`. A dismissal asks nothing of the
  agent, so it is not news.
- **The agent's line.** For an accepting comment the digest prints only
  `Reviewer accepted offer o_… on <path:start-end> (commit N): <label>. Reply with follow-me reply <cid> --diagram <file> [--map <file>].`
  (`on commit N` for a commit offer), with the place and label read from the plan the comment was
  made on and the range the hunk's tip lines. While an accepted offer has no agent reply, the entry's
  `next:` names the oldest one. A reply may be only a diagram: `--body` is optional with
  `--diagram`, and the server takes an empty body only then.
- **State maps.** `Reply.map = { states: { <name>: Loc[] }, transitions?: [{ from, to, event?, at: Loc[] }] }`
  in tip lines ties a stateDiagram to code, so the page can make states clickable and derive their
  coverage from lcov; the agent never states coverage. Every state has at least one place; `at` of a
  transition may be empty. The server (`parseNewReply`) checks the shape, that a map comes with a
  diagram, that transitions name states of the map, and with a `stateDiagram` that every state name
  appears in it as a word. `follow-me reply --map` also checks against the tip: every path is a file
  there and every range ends within it, listing every bad entry (`map.states.Idle[1]: …`) at once.
  Paths are typed as UTF-8 and stored as git's bytes, like coverage paths. The map lives on the reply,
  so swaps carry it as they carry replies, and `follow-me show <c_…>` prints it one line per state
  and transition.
- **Transition coverage.** The page marks each transition from the run over its `at`: with per-test
  runs a test takes it when that test ran every executable line there, and the edge is green with
  the count of such tests or red and dashed with ✕ when none does; with an aggregate run only, green
  when every line ran, else red, with no test names; grey (Mermaid's own) with no lines, no run, or
  a stale file. Edges are found in Mermaid's SVG by the states nearest their two ends, then by label;
  the transition table, with its Tests column, stays the way to every transition.
- **Not driven by any one test.** With per-test runs, the page lists sequences from the initial
  state (`[*] -->`, else the map's first state) to a final one (`--> [*]`, or a state nothing
  leaves), up to five transitions with none repeated, each step of which some test takes but no one
  test takes whole; sequences with an untested step are left out. Three show, shortest first, then
  "+N more". Show outlines one on the diagram; Flag as missing test opens a flag box on the commit,
  posted through `api/comments` like any flag.
- **Refs.** An inline code span of the agent's words that is wholly `path:a[-b][@n|@base]`, with a
  letter and a `/` or `.` in the path, points at code (`src/refs.ts`). `follow-me reply` and
  `explain` resolve every one against the open plan and the tip and refuse the body naming each bad
  ref at once, like `--map`. They are stored beside the body as `refs: CodeRef[]`, numbered in order
  of first appearance, each with up to 8 quoted lines, the tip it was resolved on, and where its
  lines sit there: `lines` (tip lines) and `old` (base lines the branch removes). Storing tip lines
  keeps a ref valid across plan versions; once the tip moves the page shows it stale, with the quote.
  `follow-me show` takes the same grammar.
- **Coverage follow-ups.** `follow-me coverage --reset` alone removes coverage.json, and with an lcov
  starts that run from nothing, so a series of `--test` runs does not fold into an old aggregate. A
  test whose `--at` file the branch does not change gets `preview`, up to 8 tip lines from `start`,
  decoded as UTF-8, so the page can peek without a definition lookup.

## Interactive loop

A review is a conversation, so the agent talks to the review server, not to files. The server
holds each hosted session's state in memory and appends everything that happens to an event log;
files stay the durable record written as it goes (`reviews/vN.draft.json`) and at the end.

- **Event log.** `seq` counts from 1 at registration and never repeats. `GET api/events?since=&timeout=`
  long-polls it (default 25 s, at most 60 s) and returns `{ seq, events }` at once when there is news,
  else `{ seq, events: [] }` at the timeout. `GET api/events/stream` serves the same log as
  Server-Sent Events: it replays after `since` (or `Last-Event-ID`), pushes each new event, pings every
  15 s and closes after `ended`. Every mutation emits one event: `comment`, `comment-updated`,
  `comment-deleted`, `reply`, `concern`, `resolved`, `version`, `coverage`, `submitted`, `ended`. `since` beyond the log is a 409,
  because a restarted server restarts the count. `api/state` carries the current `seq`, so a page
  that reads state and then polls from it misses nothing.
- **No held flags.** Every comment reaches the agent the moment the page posts it: `watch`, the bare
  entry, the prompt and the report all see it. Older pages send `pending: true`; the parser drops it.
  `POST api/submit` changes no comment and emits one `submitted` event, which tells the listening agent
  the reviewer is done, so the bare entry prints the report.
- **Replies.** `Comment.replies` holds the conversation under a comment, posted to
  `POST api/comments/<cid>/replies` by the agent (`follow-me reply`) or the reviewer. They are
  autosaved and written into the review. A page's `PUT` of a comment never overwrites them.
- **Row offsets.** `Anchor.hunk.offsets` lists 0-based, strictly ascending positions in the hunk body
  of the rows a reviewer picked, context rows included, within one hunk. `changes` keeps its meaning
  (the change indices among the picked rows) and is `[]` when only context is picked. The server
  rejects an offset at or beyond the body length with a 400 and leaves the draft as it was; it does not
  check `changes` against the rows. `context.lines` snapshots the picked rows. Prompt, `watch` and the
  report print the file line range (tip numbers, base numbers marked "base side" when a picked row is a
  removal) and quote the hunk as the commit writes it with picked rows marked `>`.
- **Explain.** `Comment.author: "agent"` marks a thread the agent started, with an optional `diagram`.
  `follow-me explain` posts one (plan, commit message or hunk anchor) and `watch` hides it like the
  agent's replies. Such a comment needs no `responses` entry; the report lists it under "Threads you
  started" only once the reviewer has replied.
- **Decision time.** `ConcernDecision.decidedAt` is set by the server on every decision (a client value
  is ignored), saved with the draft and the review, and sent in the `concern` event, so a timeline can be
  ordered after a restart.
- **In-place swap.** `POST api/version { version, hash }` moves the hosted session to a newer frozen
  plan under the same id and URL. The new plan loads first through the same loader as a fresh
  registration, with the lock the server already holds, so a plan that no longer fits changes nothing.
  Then the old version's review is finalized to `reviews/vN.json` (and `vN.md`) if anything was said,
  and the comment set starts empty. The review session goes on: everything said on every version
  swapped in since the page opened is carried onto the new diff (see "One review across versions").
  `api/state.previous` is `{ version, comments, responses }`: the comments of the review before this
  version, finished or still an autosave, and what this plan answered. `api/state.carried` and the
  `version` event's `carried` place the session's earlier comments on the new diff, followed by any
  comment of `previous` the session does not hold (a review that ended before this one began).
  `POST api/comments/<cid>/replies`, `api/resolved` and `api/excluded` take any of those ids;
  replies are saved under `earlierReplies` in this version's draft and review, since the old review
  file is written once, and are merged into `previous` and `carried`.
  `follow-me apply` and the bare entry do the swap when the server hosts the session, writing the
  branch under the server's lock.
- **Validation sees live comments.** `session.priorReview` returns the autosave of an unfinished
  review when it is newer than every finished one, so `check` and `apply` accept responses to comments
  that exist only on the open page.
- **Report.** `renderReport` in `prompt.ts` is the one renderer: reviewer comments and the agent's kept
  concerns by file in diff order and by line, severity in each heading, the hunk quoted as that commit
  writes it, both voices, replies under their comment, questions and their answers last. Undecided and
  dismissed concerns are left out, and so are items the reviewer excluded, which close the report under
  a short "Excluded" list. `follow-me report` (`feedback` is its old name), `GET api/report` and the
  `vN.md` written on end all call it. For a review that swapped versions it renders the whole
  session on the open version's diff (see "One review across versions").
- **Concerns and questions.** A plan may carry `concerns` on commits and unit refs; validation derives
  `k_` ids, allows one per unit, and the reviewer's decisions live in `Review.concerns`. A comment of
  `kind: "question"` is answered by a response with status `answered` whose `at` points at narration or a
  diagram in the new plan; validation rejects an answer that points at nothing.

## Entry point

The user never types a follow-me command; the agent runs `follow-me` with no command, and each call is
idempotent and returns. It syncs the skill into every detected harness, opens the session (re-extracting
if the tip moved), and then does the first thing that applies: if the review is already hosted, it just
listens; if the draft is invalid or fails the syntax gate, it prints the issues; if there is no plan for
the tip, it writes `prompt.md` and says where; if the plan already has a review, it prints the report;
otherwise it applies (author mode) or only freezes (reviewer mode), starts or attaches the server, opens
the browser on that first launch only, and listens. Mode is a split already applied, else whether the
configured `user.email` wrote every commit of the branch (`--author` and `--reviewer` override).

After it launches the page the entry prints `follow-me is interactive: keep running it until it prints
the report`, and every `next:` line while the page is up says the reviewer is still working and to run
`follow-me` again; only `submitted` and `ended` say otherwise.

Listening long-polls `api/events` for up to `--wait` seconds (default 90, at most 300) from a cursor
kept in `cursor.json` beside the session. The cursor holds `seq`, which counts only while the log is
the same one (the hosted session's id and `openedAt`), and `seen`, every comment and reply id already
read. A repeated call prints only what is new; after a restart it reads the new log from 0 and drops
what `seen` holds, so renumbered events are neither replayed nor skipped. The agent's own replies and
version swaps are not news. A `submitted` or `ended` event ends the loop with the report.

## What the agent reads

Everything follow-me prints or writes for the agent costs tokens on every call, so fixed text lives
in the skill, which a harness loads once: "Writing the draft" holds the format, the rules, the
top-down order, the question protocol and the concern guidance, and `porting.md` beside it holds the
posting steps, read only when asked. `prompt.md` keeps session data (draft path, base, tip, check
command, units, open comments) and one line naming that section and the skill file. Anything the agent
already read travels as a ref (`h_`, `c_`, `k_`, `path:line@n`) that `follow-me show` expands, as the
split writes it rather than as the tip does. A comment the agent has not seen keeps a quote of at most
six rows of 160 characters, because without it the agent reads a file, and may read the tip instead of
the commit. `scripts/measure-tokens.ts` drives a whole session on the fixture and on a pinned real
branch and prints bytes and estimated tokens per step; `docs/token-budget.md` has the numbers before
and after each cut and the blind check that the agent's work did not get worse.

## Reconnect

A server can die under an open page and a listening agent. The page autosaves every comment, reply and
decision to `reviews/vN.draft.json`, so the draft is the source of truth. When `follow-me` or `watch`
finds the session's lock naming the pid in `server.json` and that pid dead, it starts a detached server
on the recorded port, registers the latest plan again (the loader takes over the stale lock and reads
the draft) and prints `review server restarted, nothing lost`. A new session's log begins with a replay:
one `comment` event per saved comment (without its replies) and one `reply` event per reply, ordered by
`createdAt`, so `api/events?since=0` and the stream rebuild the conversation. The same port keeps the
page's origin, so it reconnects on its own; when another program holds the port the server takes a free
one and the CLI prints the new URL and says the page must be reopened. A pid that is alive but does not
answer is left alone, since its lock cannot be taken.

## Live update after a code change

The reviewer flags "change X" on some rows; the comment reaches the listening agent at once. The agent
edits the original branch, commits, and runs `follow-me`. The tip has moved, so:

1. `openFresh` re-extracts into the same session: new anchor and diff, plans and reviews kept.
2. `sinceLastPlan` loads the latest plan's own diff from its `base` and `tip` and runs
   `evolvePlan(oldPlan, oldDiff, newDiff)` (`src/evolve.ts`, pure). Unit ids hash path and hunk
   body, so a surviving id is the same hunk: every ref to it stays where it was, refs to vanished
   units are dropped, a commit left with none is dropped, responses start empty. It returns the
   draft, the vanished units with the old commits that took them, and the added units.
3. If `draft.json` is not already for this tip, the carried draft is written. While it does not
   validate, `prompt.md` is the short re-plan form: vanished units with their old commit, new units
   with their bodies, unchanged units one line each with their commit in the draft, and every open
   comment by id, quoted (at most six rows) only when the hunk it was on changed; and
   the entry prints `next: assign the new units in draft.json, then run follow-me again`.
4. Once it validates (at once when nothing vanished or appeared), the entry checks syntax, applies
   under the server's lock (only freezes for a walk), swaps the open page with `api/version` and
   prints `swapped the open page to plan v<N+1>; carried M comments, K changed` and where each
   changed thread now points. The agent then answers with `follow-me reply <id>`.

Every step reads only what is on disk and in git, so a repeated or interrupted call converges.

The loader computes `carried` with `carryComments(previous.comments, oldUnits, newUnits)`, one
entry per comment of `previous`, in order:
`{ comment, unit: UnitId | null, offsets: number[] | null, changed, path, newLine: number | null }`.
A unit still in the new diff keeps its id and offsets, `changed: false`. A vanished one is replaced
by the hunk of the same path whose tip lines cover, or come closest to, the comment's old tip line,
with `changed: true` and no offsets; `newLine` is the nearest row with the same text, else the old
line clamped into that hunk. Nothing left on the path gives `unit: null`. Comments not on a hunk
carry with `unit: null, changed: false`. When the old commits are gone from the repo, vanished
comments carry to the first unit on their path with `newLine: null`.

## One review across versions

The reviewer answers the code writer once, at the end, so one review is everything said while the
page stayed open, whatever versions were swapped in. At each swap the server carries (`carrySession`
in `src/evolve.ts`) what the session already carried, moved again from its place on the old diff,
plus the comments said on the old version. A placement that changed stays changed; a kept unit
keeps it in place (its line shifts with the hunk), a vanished one moves to the nearest hunk of the
path by its last line, and a path with no hunks left leaves it on no unit: the code is gone.
`since` records the last version whose code it still matched. Kept concerns the next plan no
longer has are carried the same way with their decision (`carryConcerns`); decisions on concerns
the next plan still has, resolutions and exclusions move into the new view as they are.

On disk the session lives beside the open version, with nothing copied: `reviews/vN.draft.json`
and then `reviews/vN.json` hold `carried`, one `{ version, comment, since, unit, offsets, changed,
path, newLine }` per earlier comment (the comment itself stays in `reviews/v<version>.json`, its
later replies in the `earlierReplies` of the versions after it), and `carriedConcerns`, each
concern whole with its decision, since no review file holds it. `carried` present, even empty,
means this version continues a review. The swap writes the new draft at once, so a restarted
server's loader reads `carried` back (`sessionComments` in `src/session.ts`) and the session goes
on; `follow-me report` reads a finished `vN.json` the same way. Older review files have no
`carried` and read as reviews that began on their own version.

The report folds the session in before rendering: an unchanged comment keeps its rows (its commit
is the one that now takes its hunk), a changed one points at the row of its carried line, or at
its hunk when it has none, and is labelled "the code changed after v<since>"; a gone one is listed
under its path as "the code is gone after v<since>" with the rows it quoted; message and plan
comments stay as they are. Each id appears once.

## Hand-off

follow-me never holds a forge token, so the end of a review is a hand-off, not a post. The reviewer
decides what leaves: `Review.excluded` lists the comment and concern ids to keep out
(`POST api/excluded { comment | concern, excluded }`, autosaved, written into the review and sent in
`api/state`). `follow-me report --json` (and `GET api/report?format=json`) prints every item as
`{ id, path, oldPath, newLine, oldLine, startNewLine, startOldLine, severity, kind, body, thread,
resolved, excluded }` in file order, plus `changed: { since, gone }` on an item said on an earlier
version whose code changed after v`since` (or is gone, with no lines), and `covered` on a flag or
concern over added rows when a test run still fits its file. `id` names the comment or
concern, so the page toggles a carried item like any other. Line numbers are the original branch's: the tip's for an added or context
row, the base's for a removed one, computed from the hunk and the projected commit as the quoting code
does. The split's last tree equals the tip, so the numbers are the ones a merge request shows for the
same base. The agent, not follow-me, then posts the non-excluded items with `glab` or `gh`, after
checking that the merge request head is the tip (see `skills/follow-me/porting.md`).
