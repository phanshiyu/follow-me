# Architecture contract and driftwall review: follow-me

`docs/architecture.mmd` is this project's architecture as a design: a small set of components,
each with one responsibility, grouped in layers, and arrows for the dependencies the design
**allows**. The `%% map` lines in the same file assign every source file to a component, and the
`%%` comments record why each non-obvious arrow exists, which directions are forbidden, the debt
the code has today, and the rules a tool cannot check yet. The reasoning behind each component and
violation is in [`architecture-notes.md`](architecture-notes.md).

[driftwall](https://github.com/phanshiyu/driftwall) checks the contract: it parses every source
file (tree-sitter), resolves each import to a file and a component, and reports every dependency
the design does not allow. Arrows marked `-->|test|` allow only test code to cross.

Reviewed 2026-11-23 with driftwall `daaf073`.

## Review

An independent review agent judged the contract against a six-point rubric: right components,
complete mapping, real layers, arrows that allow only the intended dependencies (debt stays visible
as violations), fidelity to the project's own docs, and usefulness to a newcomer. **Satisfactory in
round 2.** The code is genuinely well layered: the production graph has no cycles, the browser page
reaches `src/` only through type imports in `wire.ts`, and only one violation remains. Round 1
found that `agent` merged the planner prompt with the skill installer, which would have let the
server import the installer; `install` is now its own component. The Node program and the browser
page are drawn as separate stacks.

Debt lint cannot report (recorded in the contract): `cli.ts` writes session files itself despite
`types.ts` giving `.follow-me/` to `session`, and `comments.ts` reaches `git.ts` through `coverage.ts`.

## What lint reports today

16 components, 53 arrows (38 implemented, 15 test).
**1 violations** in 1 groups, 0 warnings. Each violation is a
place where the code breaks the design; the notes give the fix for each.

- **tooling → tests** (1):
  - `scripts/measure-tokens.ts:19`

## Components

| Component | Responsibility | Files |
|---|---|---|
| `agent` | planner prompt, events, show and consolidated report text | 1 |
| `cli` | composition root, argv and command orchestration: entry, listen, hosting | 2 |
| `domain` | pure diff, plan, evolve, naive plan, syntax gate and text sanitizers | 6 |
| `evidence` | what the tip shows about the diff: lcov coverage, definitions, code refs | 3 |
| `git` | the only src module that spawns git, loads a Diff and writes a branch | 1 |
| `install` | sync the skill into each detected harness | 2 |
| `server` | the one review server per user, its session registry, JSON API, static page and its HTTP client | 2 |
| `session` | .follow-me/ layout, review wire formats and comment parsing | 2 |
| `tests` | real-git fixture and the node test suites | 21 |
| `tooling` | repo scripts, vite config and dev stubs | 10 |
| `types` | domain types shared by every module, no logic | 1 |
| `ui-app` | browser entry, mounts the page and picks review or handoff | 3 |
| `ui-components` | React components, one per card, thread or panel | 49 |
| `ui-lib` | page logic and React hooks, the API client and the wire types | 47 |
| `ui-state` | React providers holding server state and page navigation | 2 |
| `ui-testkit` | fake server, factories and page builders for UI tests | 4 |

## What driftwall cannot see

- Files in languages it does not read: none.
- References it saw but could not turn into dependencies: file-reference-missing 5 (`driftwall brief` lists each one).
- Anything that is not an import: subprocess calls, file paths in strings, network calls, and the
  rules listed under "Not expressible yet" in the contract.

## Use it

```sh
driftwall lint --contract docs/architecture.mmd            # violations, exit 1 if any
driftwall where <file> --contract docs/architecture.mmd    # which component owns a file
driftwall neighbors <component> --contract docs/architecture.mmd
```

Fix a violation by changing the code, or, if the design should change, by editing the contract in
review. Add `driftwall lint --contract docs/architecture.mmd` to CI once the violations are fixed
or accepted.
