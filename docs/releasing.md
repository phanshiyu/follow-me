# Releasing

Releases are published to npm by GitHub Actions through npm's trusted publisher
(OIDC). No token is stored anywhere. The workflow is `.github/workflows/publish.yml`
and it has three ways to start a release, described below. It runs as four jobs, so no
job holds more than one power:

- `decide` (read-only) says what to release, if anything.
- `build` (read-only) installs, runs every gate, bumps the version for an automatic
  release and packs the tarball. It is the only job that runs the repository's code.
- `push` (`contents: write`) checks nothing out. It takes `package.json` and
  `package-lock.json` from the build, refuses anything but version lines, then commits,
  tags and pushes in one atomic push.
- `publish` (`id-token: write`, environment `prod`) checks nothing out and publishes the
  tarball the build packed, after checking its version.

No job restores or saves a cache. `test/publish-workflow.test.ts` pins these rules.

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

   The workflow refuses a tag whose version differs from `package.json`. Only a pushed
   tag publishes a tag: starting the workflow by hand with a tag selected does nothing.

A manual start ("Run workflow") releases only the head of `main`, and only when a bundled
library changed. From any other branch or tag, or when `main` has moved on, it does nothing.

Every path runs lint, typecheck, build and both test suites before it publishes. A red
suite blocks the release, and the automatic paths leave `main` and the tags untouched
when that happens. For an automatic release the version commit and tag are pushed before
the publish, so that npm never holds a version missing from `main`.

## What never releases

- Tooling updates (biome, typescript, vite, vitest, playwright, `@types/*`): they never
  reach users, so they never need a release. Renovate still merges them.
- A push to `main` that is not a security update, such as a feature, a fix or a docs change.
  Those go out when you tag.
- A run where nothing bundled changed since the latest tag.
- The version commit the workflow itself pushes (`chore(release): vX.Y.Z`). It is
  skipped explicitly, and a push made with `GITHUB_TOKEN` starts no workflow anyway.

Releases run one at a time. If the publish step fails after the commit and tag were pushed,
the version exists in git but not on npm: the `publish` job failed, so fix the cause and re-run
that job, or delete the tag (`git push --delete origin vX.Y.Z`), then re-create and push the tag
from the version commit to publish it.

## Repository settings the automatic paths rely on

- **Branch protection on `main`**, if you turn it on, must let the GitHub Actions app push
  the release commit straight to `main` (for example by adding it to the bypass list of the
  ruleset). Otherwise the push fails and nothing is published. There is none today.
- **The `prod` environment**, if it restricts which branches or tags can deploy, must allow
  `main` as well as `v*` tags.
- **Dependabot alerts**: on (Settings, Advanced Security). This
  gives Renovate GitHub's advisory data. Leave Dependabot security updates and version
  updates off; Renovate opens the pull requests, GitHub only supplies the alerts. Renovate's
  OSV source (`osvVulnerabilityAlerts`) works whether or not this is on.
- **Auto-merge** is allowed on the repository. `renovate.json` keeps `platformAutomerge` off,
  so Renovate itself waits for CI to pass and then merges; GitHub's auto-merge with no
  required check would merge before CI finished. If you add a rule that requires `ci-ok`,
  you can turn `platformAutomerge` on. The merge must not be made with `GITHUB_TOKEN`, or the
  push to `main` would not start the workflow.
- **The Renovate app** must be installed on the repository (github.com/apps/renovate).

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
