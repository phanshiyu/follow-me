# follow-me

Split a branch's net change into fine, story-ordered commits, review them hunk
by hunk, and hand the review back to an agent. Read `docs/DESIGN.md` before
touching `src/`. The domain types in `src/types.ts` are the contract.

## Commands

- `npm run check` runs lint (biome), typecheck (strict tsc) and tests (node --test). CI runs the same three. Keep it green before every commit.
- `npm run lint:fix` formats and fixes.
- `node bin/follow-me.ts <command>` runs the CLI from source. No build step.

## Rules

- Node 24+ runs the `.ts` sources directly, so only erasable syntax: no enums, namespaces or parameter properties. Relative imports carry the `.ts` extension.
- No `as` casts, no non-null assertions, no `any`. Parse external data (git output, JSON files, HTTP bodies, argv) at the boundary into the domain types, then trust them.
- Tests use real git on the fixture from `test/fixture-repo.ts`. No mocks of git.
- Only `src/git.ts` spawns git. Only `src/plan.ts` can construct a `ValidPlan`.
- Commit messages: conventional-commits title, short body saying why. Small ordered commits.
- Log non-obvious decisions with `scripts/log-decision.sh` into `docs/decisions.tsv`.
