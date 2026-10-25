# Releasing

Releases are published to npm by GitHub Actions through npm's trusted publisher
(OIDC). No token is stored anywhere. The workflow is `.github/workflows/publish.yml`
and it has three ways to start a release, described below.

## One-time setup on npmjs.com

Package `@shiyuphan/follow-me`, Settings, Trusted Publisher, GitHub Actions:

- Organization or user: `phanshiyu`
- Repository: `follow-me`
- Workflow filename: `publish.yml`
- Environment: `prod`

The configuration expires if no publish succeeds within two days of creating it.

## The three ways a release happens

The web page follow-me serves is built from a few libraries (React, Mermaid, Marked,
DOMPurify, Prism, Radix, Tailwind and friends) that get copied into the published
package. Updating them in the repo changes nothing for users until a new version is
published, so the workflow publishes for them. The full list is `BUNDLED` in
`scripts/bundled-changed.ts`, and `renovate.json` groups the same names as "bundled UI deps".

1. **A security fix releases when it merges.** Renovate opens security pull requests at
   any time, labelled `security`, and merges them once CI is green. Its commit title ends
   in `[SECURITY]`. When such a commit lands on `main` and it changed a bundled library,
   the workflow bumps the patch version, publishes, and pushes the version commit and tag
   back to `main`. A security fix to tooling only (lint, tests, types) does not release,
   because users never run that code.
2. **A weekly release picks up bundled updates.** Every Monday (and on demand from the
   Actions tab, "Run workflow") the workflow compares the lockfile now with the lockfile at
   the latest `v*` tag. If any bundled library, or anything it depends on, is at a
   different version, it releases a patch. Otherwise it does nothing.
3. **A manual tag, as before.** For a minor or major release, or any time you want to
   decide yourself:

   ```sh
   npm version minor        # or patch, major; bumps package.json and creates the v-tag
   git push --follow-tags   # the tag triggers publish.yml
   ```

   The workflow refuses a tag whose version differs from `package.json`.

Every path runs lint, typecheck, build and both test suites before it publishes. A red
suite blocks the release, and the automatic paths leave `main` and the tags untouched
when that happens.

## What never releases

- Tooling updates (biome, typescript, vite, vitest, playwright, `@types/*`): they never
  reach users, so they never need a release. Renovate still merges them.
- A push to `main` that is not a security update, such as a feature, a fix or a docs change.
  Those go out when you tag.
- A run where nothing bundled changed since the latest tag.
- The version commit the workflow itself pushes (`chore(release): vX.Y.Z`). It is
  skipped explicitly, and a push made with `GITHUB_TOKEN` starts no workflow anyway.

Releases run one at a time. If the publish step fails after the commit and tag were pushed,
the version exists in git but not on npm: delete the tag (`git push --delete origin vX.Y.Z`),
fix the cause, then re-create and push the tag from the version commit to publish it.

## Repository settings the automatic paths rely on

- **Branch protection on `main`**, if you turn it on, must let `github-actions[bot]` push
  the release commit straight to `main` (for example by adding it to the bypass list of the
  ruleset). Otherwise the push fails and nothing is published.
- **The `prod` environment**, if it restricts which branches or tags can deploy, must allow
  `main` as well as `v*` tags.
- **Dependabot alerts**: turn on "Dependabot alerts" under Settings, Advanced Security. This
  gives Renovate GitHub's advisory data. Leave Dependabot security updates and version
  updates off; Renovate opens the pull requests, GitHub only supplies the alerts. Renovate's
  OSV source (`osvVulnerabilityAlerts`) works whether or not this is on.
- **Auto-merge** should be allowed on the repository so Renovate can merge its pull requests
  once CI passes. The merge must not be made with `GITHUB_TOKEN`, or the push to `main` would
  not start the workflow.

## If a release lands in staging

Releases go live directly; `0.1.1` and `0.2.0` did. The registry can take a few minutes
to update `latest` after the version appears. If a future trusted publisher is configured
as stage-only, the workflow's `npm publish` lands the version in npm's staging queue
instead, and a maintainer approves it with 2FA on the package page or from a logged-in
terminal:

```sh
npm stage list @shiyuphan/follow-me
npm stage approve <stage-id>
```

The `0.0.0-stage` entry in the version list belongs to npm's staging machinery.
