# Security

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Please do not open a public issue. Fixes go into the latest release only, so update to the newest version of `@shiyuphan/follow-me` to get them.

## What CI checks

- Every pull request and every push to `main` runs lint, type checks, the build, both test suites and a run of follow-me on its own history. One final check, `ci-ok`, passes only when all of them passed.
- A dependency audit (`npm audit`, moderate severity or worse) fails a pull request only for an advisory its base branch does not already have. That way an advisory on `main` never blocks the pull request that fixes it.
- A second audit packs the package, installs it into an empty folder, and audits what a user would get. The package has no runtime dependencies today (the web page is bundled when it is built), so that tree is empty. The check keeps it that way, or audited if one is added.
- A separate daily audit of `main` (`audit.yml`) keeps one issue open while `main` has an advisory, and closes it when `main` is clean.
- GitHub's code scanning (CodeQL, extended queries), secret scanning with push protection, and Dependabot alerts are on. Dependabot only raises alerts; it opens no pull requests.

## How dependencies are updated

Renovate opens the pull requests (`renovate.json`). It waits three days after a release before proposing it, except for security fixes, which it proposes at once with a `security` label.

- Merge themselves once CI is green: minor and patch updates, pins, action digests, and the weekly lock file refresh. Renovate merges them, not GitHub's auto-merge, because there is no required check on `main` (see the settings below).
- Wait for a person: major updates, and minor updates of anything below version 1.0.
- Action versions in the workflows are pinned to a commit, with the version in a comment, so a moved tag cannot change what runs.

## How a release goes out

Releases go to npm from GitHub Actions only, through npm trusted publishing: no npm token is stored anywhere. See `docs/releasing.md`.

- The job that installs and builds has read-only access. The job that pushes the version commit never checks out or runs the repository's code. The job that publishes holds only the npm identity token, checks nothing out, and publishes the tarball the build packed. No job restores or saves a cache.
- A release starts from a pushed `v*` tag, from a Renovate security fix that changed a library the web page bundles, or from the weekly run when such a library changed. A manual start can only release the current head of `main`.
- A test (`test/publish-workflow.test.ts`) reads the workflows and fails if these rules are loosened.

## Repository settings these rely on

- Dependabot alerts: on. Dependabot security updates: off, so Renovate and Dependabot do not both open the fix.
- Private vulnerability reporting: on.
- Secret scanning and push protection: on. Code scanning default setup: on, extended query suite.
- Allow auto-merge and delete head branches on merge: on.
- The Renovate app (github.com/apps/renovate) is installed on this repository.
- Environment `prod` and the npm trusted publisher name `publish.yml` and `prod`. Changing either stops releases.
- If you add a rule that requires `ci-ok` on `main`, let the GitHub Actions app bypass it (the release commit has no CI run of its own), and then you can turn on `platformAutomerge` in `renovate.json`.
