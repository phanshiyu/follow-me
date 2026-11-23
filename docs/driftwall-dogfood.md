# driftwall dogfood: follow-me

This project was used to test [driftwall](https://github.com/phanshiyu/driftwall), a linter that
fails the build when code drifts from an architecture diagram. `docs/architecture.mmd` is the
diagram `driftwall init` derived from this repository's code with no hand-written input: one node
per architectural unit, one edge per dependency it found in the source. An independent review
agent then checked the result against the code. This page records what it found.

- driftwall commit `f14a200` (binary `driftwall-r5`), reviewed 2026-11-23.
- The `.arch` tag files `init` writes are not committed; the diagram is a snapshot, not yet an
  enforced contract. See [Reproduce](#reproduce) to regenerate it or adopt it.

## Verdict

**Satisfactory** after 4 review rounds (rounds 1 and 2 unsatisfactory, 3 and 4 satisfactory).

- Precision and recall: 367 of 367 cross-node import sites in both directions; symbols match on
  all 105 edges.
- Granularity: `src/` is a flat CLI, so its modules are one node each (`cli` fans out to 16); the
  `ui` app splits into its components, src, test and server parts.
- Earlier rounds found: `src` holding most of the code in one node; `ui/index.html`'s `/src/main.tsx`
  resolved against the wrong root; orphan test files as nodes; `index.css` owned by an undeclared
  node. All fixed in driftwall.

## Observations for this project

- `ui-components` ↔ `ui-src` is a production cycle: 30 runtime imports one way, 2 the other.
- `scripts` ↔ `test` cycle.
- The UI test fixtures import real components (`ui-test` → `ui-components`: Handoff, ReviewPage).
- `test/cli.test.ts`, `test/coverage.test.ts` and `test/install.test.ts` spawn `bin/follow-me.ts`
  through `new URL(...)`.

## Measured

| | |
|---|---|
| Nodes | 31 |
| Edges | 106 |
| Source files mapped | 156 |
| Import sites behind the edges | 370 (runtime 302, type-only 66, asset 2; 119 test-only) |
| init + lint + brief wall time | under 1 s |
| Files driftwall cannot read | none |
| Files excluded (generated, vendored, minified) | none |
| Files ignored by `.driftwallignore` | 0 |
| Skipped references (visible, not edges) | file-reference-missing 5 |
| Unresolved imports | 0 |

## Structure facts computed from the graph

- Highest fan-out: `cli` (16), `test` (16), `server` (9), `host` (7), `session` (7).
- Highest fan-in: `types` (19), `diff` (12), `plan` (10), `coverage` (6), `git` (6).
- Dependency cycles through production code (runtime, asset or embed imports outside tests):
  - `ui-components` ↔ `ui-src`
- Further cycles that exist only through type-only or test imports:
  - `ui-components` ↔ `ui-lib` ↔ `ui-src` ↔ `ui-test`
  - `scripts` ↔ `test`

## Skipped references

References driftwall saw but did not turn into edges, with the reason. First five per reason;
`driftwall brief --format json` lists all of them.

- **file-reference-missing** (5):
  - `src/server.ts:146` `../ui/dist/`
  - `test/coverage.test.ts:179` `fixtures/lcov/`
  - `test/publish-workflow.test.ts:20` `../`
  - `ui/vite.config.ts:18` `.`
  - `ui/vite.config.ts:28` `./src`

## Reproduce

```sh
# install driftwall, then from the repository root:
driftwall init . --contract docs/architecture.mmd   # writes .arch tags and the diagram
driftwall lint --contract docs/architecture.mmd     # exit 0: code matches the diagram
driftwall brief --contract docs/architecture.mmd    # nodes, edges, blind spots
driftwall neighbors <node> --contract docs/architecture.mmd
```

To enforce the diagram, commit the `.arch` files, edit `docs/architecture.mmd` into the
architecture you intend (drop edges you consider violations, group nodes into subgraphs), and run
`driftwall lint --strict --contract docs/architecture.mmd` in CI.
