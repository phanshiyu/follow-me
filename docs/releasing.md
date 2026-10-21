# Releasing

Releases are published to npm by GitHub Actions through npm's trusted publisher
(OIDC). No token is stored anywhere. The workflow is `.github/workflows/publish.yml`
and it runs on any tag that starts with `v`.

## One-time setup on npmjs.com

Package `@shiyuphan/follow-me`, Settings, Trusted Publisher, GitHub Actions:

- Organization or user: `phanshiyu`
- Repository: `follow-me`
- Workflow filename: `publish.yml`
- Environment: `prod`

The configuration expires if no publish succeeds within two days of creating it.

## Cutting a release

```sh
npm version patch        # or minor, major; bumps package.json and creates the v-tag
git push --follow-tags   # the tag triggers publish.yml
```

`npm publish` runs `prepublishOnly` first, which is lint, typecheck, tests and the
build, so a red suite blocks the release. The workflow also refuses a tag whose
version differs from `package.json`.

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
