# follow-me designed contract: notes

Contract: `docs/architecture.mmd`
Result: 16 components, 38 solid + 15 test + 0 planned edges, 0 warnings, 0 unmapped, 1 violation.

## Sources
README, CLAUDE.md (rules: only git.ts spawns git, only plan.ts builds ValidPlan, types.ts is the contract), docs/DESIGN.md,
docs/harnesses.md, docs/driftwall-dogfood.md, the `src/types.ts:1-20` module map, module header comments, ui/src/lib/wire.ts:1-3,
the draft contract and `brief`/`neighbors` on it.

## Layers (left to right)
Subgraphs: Tooling and tests (tooling, tests, ui-testkit) | Node stack: entry, features, review state, evidence, infrastructure, foundation | Browser stack: entry, review page, foundation. The two stacks share only src/types.ts via ui/src/lib/wire.ts.
Rationale: src/types.ts:1-20 lists the modules from pure semantics (diff, plan) up through git, session, comments,
definition, coverage, prompt, server, host, cli. Imports follow that order; Evidence sits between session and git
because coverage/definition read the tip through git.ts while comments/session parse their output.
The UI is its own stack (ui-app -> ui-components -> ui-state -> ui-lib -> types). It shares only src/types.ts with src/.

## Components, responsibility, evidence
- cli: src/cli.ts (2567 lines), bin/follow-me.ts. Labelled as it is: argv and command orchestration, entry, listen, hosting. The types.ts:20 goal ("argv -> one call") is not met; see observations. Fans out to 8 nodes.
- ui-app: ui/src/App.tsx, main.tsx. App.tsx:2-7 picks Handoff or ReviewPage and wraps in ReviewProvider.
- tooling: scripts/ (audit, bundled-changed, measure-tokens, dogfood, log-decision), ui/dev/stub.ts, ui/vite.config.ts, ui/index.html, .claude/skills/verify-follow-me scripts. Dev and release tooling, not shipped.
- tests: test/ (real git on test/fixture-repo.ts, CLAUDE.md "Tests use real git") and src/*.test.ts.
- server: src/server.ts, src/host.ts. docs/DESIGN.md "One server, many sessions": one review server per user, registry, JSON API, serves ui/dist (server.ts:146). host.ts is the per-user record/attach/start/stop (types.ts:17-18).
- ui-components: ui/src/components/ (incl. components/ui shadcn primitives, 10 files, kept inside: a vendored directory, no own responsibility).
- ui-state: ui/src/store.tsx (ReviewProvider, server state, events) and page.tsx (PageProvider, scroll and navigation).
- agent: src/prompt.ts. Planner prompt, events, show, feedback and consolidated report text (DESIGN.md "Report. renderReport in prompt.ts"); imports coverage, diff, evolve.
- install: src/install.ts, harness.ts. Syncs the skill into harness folders (docs/harnesses.md); imports nothing else from src/. Separate from agent so server cannot reach the installer; only cli and tests use it.
- session: src/session.ts, comments.ts. `.follow-me/<slug>/` layout (DESIGN.md "Review loop") and the review wire formats (types.ts:11-12).
- evidence: src/coverage.ts, definition.ts, refs.ts. DESIGN.md: lcov coverage placed at the tip, definition lookup, code refs.
- git: src/git.ts. "Only src/git.ts spawns git" (CLAUDE.md), types.ts:8.
- domain: src/diff.ts, plan.ts, evolve.ts, naive.ts, syntax.ts, plain.ts. Pure semantics: diff parse and projection, plan validation, evolve (evolve.ts:1-4), naive plan (naive.ts:1-4), syntax gate "Pure of git" (syntax.ts:1-5), sanitizers (plain.ts:1-5).
- ui-lib: ui/src/lib/ (47 files, tests included). Page logic, React hooks (route.ts, useSpans.ts), api.ts, wire.ts. Only src importer in ui/ (wire.ts:18, :46, type-only).
- ui-testkit: ui/src/test/. Fake server, factories, pages, render ("Components, state and events run for real", test/server.ts:1-2).
- types: src/types.ts, "Domain types shared by every module. This file holds no logic." Own node because every other node and ui-lib depend on it and CLAUDE.md calls it the contract.

## The ui-components <-> ui-src cycle
Not hidden in a component; resolved by file split. The 30 imports components -> ui/src are all store.tsx/page.tsx (ui-state). The 2 imports the
other way are App.tsx -> Handoff, ReviewPage (ui-app). With App/main in ui-app and store/page in ui-state the graph is acyclic:
ui-app -> components -> state -> lib. Lint passes with no edge ui-state -> ui-components. So the draft's "production cycle" was an artefact of mapping
all of `ui/src/*` to one node. Test-only cycle remains: ui-testkit's render.tsx mounts real components, and their tests import the kit (declared
as `-->|test|` both ways, no production site).

## Violations (full list: 1)
1. scripts/measure-tokens.ts:19 `tooling` imports `tests` (test/fixture-repo.ts). GENUINE (PROJECT OBSERVATION). A production-side script depends on the test tree, and tests depend on scripts (audit, bundled-changed): the draft's scripts <-> test cycle.
   Fix, verified in a scratch copy (lint clean); CLAUDE.md line 17 names test/fixture-repo.ts and must be updated in the same change: move test/fixture-repo.ts to scripts/fixture-repo.ts (it imports only node:*), point measure-tokens.ts and the 11 test files at it. The tests --> tooling test edge already allows it.

Ruled out as non-violations (code obeys the design): server never imports git; ui never imports src except wire.ts types; domain imports only types;
evidence, session, agent are mutually acyclic (agent -> evidence, session -> evidence).

## Project observations lint cannot report (also in the contract debt block)
- cli.ts writes session files itself: cursor.json (cli.ts:1303-1337) and page.json (cli.ts:2401-2413), against types.ts:10, which gives `.follow-me/` to session. Fix: move both into session.ts.
- types.ts:11-12 calls comments.ts a "pure parser", but comments.ts imports parseLoc from coverage.ts, which imports git.ts (coverage.ts:4). Fix: move parseLoc next to refs.ts or diff.ts.
- Only git.ts spawns git is broken by scripts/measure-tokens.ts:38 and scripts/bundled-changed.ts:123 (execFileSync("git")). Not an import rule, so not expressible.

## Not expressible (also in the contract)
Only git.ts spawns git (see above); only plan.ts builds ValidPlan; ui-lib may import types type-only only; domain purity; cli.ts size (2567 lines of command
logic vs "argv -> one call"); types.ts holding no logic.

## DRIFTWALL DEFECTS
None blocking. Minor: `src/*.test.ts` maps to `tests` by glob, but there is no way to say "test files of any directory belong to node X" without listing dirs; the contract lists `src/*.test.ts` and relies on ui test files staying with their component (their imports of ui-testkit are test-only edges). Not a bug.

## Open questions
- Is the src/ flat file list in `%% map` acceptable? src has no subdirectories, so globs are file lists by necessity.
- Should cli.ts be split (2567 lines)? A file-level split would let the contract bar cli from doing work, but that is outside what lint can see.
- ui/dev stub imports ui-lib (lineNumbers, wire types): allowed as dev tooling; reviewer may call it debt.
