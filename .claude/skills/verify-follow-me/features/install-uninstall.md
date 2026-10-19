# Install and uninstall the agent skill

Install copies the follow-me skill into the skill directories of the coding agents it finds, and uninstall removes exactly those files. Both report what they did, and a rerun changes nothing.

## Sub-features

- `install-list` shows each harness, its project and user paths, and its docs.
- `install-dry-run` reports what would be written and writes nothing.
- `install-detect` writes only for harnesses it detects under HOME.
- `install-unchanged` reports `unchanged` on a second run.
- `install-project` writes into the repo with `--project`; the default is HOME.
- `uninstall` removes the files and reports `absent` on a rerun.

## How to get to it (user POV)

- Run `follow-me install` for the home skill dirs, or `follow-me install --project` in a repo for a repo-local copy.
- Run `follow-me install --list` to see the harnesses.
- Run `follow-me uninstall` with the same flags to remove what install wrote.

## Driving it with the CLI and the page API

Preconditions:

- A temp HOME and a temp repo, so nothing touches the real `~/.claude`. `mkdir -p "$EV/install"`.

  ```sh
  T=$(mktemp -d "${TMPDIR:-/tmp}/follow-me-install.XXXXXX")
  mkdir -p "$T/home/.claude" "$T/repo" && git -C "$T/repo" init -q
  cd "$T/repo" && export HOME="$T/home"
  ```

  Setting `HOME` affects only that call's shell. Re-export it in every call that runs `install`.

- **List.** `"$FM" install --list` exits `0` and prints seven harness blocks (`claude`, `opencode`, `codex`, `cursor`, `gemini`, `copilot`, `agents`), each with `project`, `user` and `docs` lines.
- **Dry run.** `"$FM" install --dry-run` prints `would write <repo>/.claude/skills/follow-me/SKILL.md`. `find "$T/repo/.claude"` finds nothing.
- **Detect and install.** `"$FM" install` prints `wrote <repo>/.claude/skills/follow-me/SKILL.md` and nothing for harnesses whose dir is absent from HOME. `cmp` that file with `skills/follow-me/SKILL.md` in the follow-me checkout. They are identical.
- **Unchanged.** Run `"$FM" install` again. It prints `unchanged <same path>`.
- **Uninstall.** `"$FM" uninstall` prints `removed <path>`, and the file is gone. Run it again for `absent <path>`.
- **User scope (default).** `"$FM" install --harness claude` writes `$T/home/.claude/skills/follow-me/SKILL.md`. `"$FM" uninstall --all` removes it and prints `absent` for the other six.
- **Bad harness.** `"$FM" install --harness claude-code` exits `1` with `unknown harness "claude-code" (known: claude, ...)`.
- **Proof.** Save each command's stdout and exit code under `$EV/install/`, plus `find "$T" -name SKILL.md` before and after.

## Gotchas

- Run install in a temp repo. In the follow-me checkout it would write `.claude/skills/follow-me/`, which this repo does not track.
- The harness id for Claude Code is `claude`, not `claude-code`.
- Detection looks at HOME. With no harness dir there, `install` exits `1` with `no harness config directory found; pass --harness <id> or --all`, so create `$T/home/.claude` first.
- Paths in output are realpaths. On macOS `$TMPDIR` shows as `/private/var/...`, so compare after resolving.
- Remove `$T` in cleanup. The shell check `ls "$TMPDIR" | grep follow-me` catches a miss.
