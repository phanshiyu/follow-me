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
