# Using follow-me from your coding agent

follow-me ships one skill, `skills/follow-me/SKILL.md`, in the open Agent Skills format
(https://agentskills.io). It tells an agent how to drive the `follow-me` CLI. Every harness below
reads that file as-is, so installing means copying the `follow-me` folder into the directory the
harness scans. The skill needs the `follow-me` command on your PATH.

## Install

Run this from the repo root to install into every harness whose config directory exists in your
home directory:

```sh
follow-me install
```

| Flag | Effect |
| - | - |
| `--harness <ids>` | Install into the listed harnesses only. Comma-separate ids, for example `claude,codex`. |
| `--all` | Install into every harness in the table, even if it is not detected. |
| `--user` | Install into your home directory instead of the repo, so every repo sees the skill. |
| `--dry-run` | Print what would be written and write nothing. |
| `--list` | Print each harness with its skill directories and docs link. |

Each file prints as `wrote`, `unchanged` or, with `--dry-run`, `would write`. Running the command
again is safe. Harnesses that share a directory (Codex and the generic `agents` entry) produce one
file.

## Uninstall

`follow-me uninstall` takes the same flags as install, except `--list`, and removes exactly the
files install would write: each `<directory>/follow-me/SKILL.md`, then the `follow-me` folder if
that left it empty. It never removes a parent directory or other files in the folder. Each file
prints as `removed`, `absent` or, with `--dry-run`, `would remove`.

```sh
follow-me uninstall                    # detected harnesses, project scope
follow-me uninstall --all --user       # every harness, home directory
```

Without `--harness` or `--all` it only visits detected harnesses, the same ones install picks, so
`--all` is the sure way to remove every copy at a scope.

For a manual install, copy the folder yourself. The folder is `skills/follow-me` in a checkout and
`node_modules/@shiyuphan/follow-me/skills/follow-me` in an npm install. A symlink works too.

## Where each harness looks

| Id | Harness | Project directory | User directory |
| - | - | - | - |
| `claude` | Claude Code | `.claude/skills/` | `~/.claude/skills/` |
| `opencode` | OpenCode | `.opencode/skills/` | `~/.config/opencode/skills/` |
| `codex` | Codex CLI | `.agents/skills/` | `~/.agents/skills/` |
| `cursor` | Cursor | `.cursor/skills/` | `~/.cursor/skills/` |
| `gemini` | Gemini CLI | `.gemini/skills/` | `~/.gemini/skills/` |
| `copilot` | GitHub Copilot CLI | `.github/skills/` | `~/.copilot/skills/` |
| `agents` | Any Agent Skills client | `.agents/skills/` | `~/.agents/skills/` |

The skill lands in `<directory>/follow-me/SKILL.md`. Several harnesses read more than one
directory, and OpenCode, Cursor, Gemini CLI and Copilot also read `.agents/skills/`. If two copies
of the skill are visible, the harness keeps one and may warn, so install into one place per
harness.

## Claude Code

```sh
follow-me install --harness claude
# manual
mkdir -p .claude/skills && cp -R /path/to/follow-me/skills/follow-me .claude/skills/
```

Type `/follow-me`, or ask in plain words: "split this branch into a story of commits".

Docs: https://code.claude.com/docs/en/skills

## OpenCode

```sh
follow-me install --harness opencode
# manual
mkdir -p .opencode/skills && cp -R /path/to/follow-me/skills/follow-me .opencode/skills/
```

OpenCode lists the skill to the agent, which loads it through its `skill` tool. Ask in plain words:
"use the follow-me skill to clean up this branch". OpenCode also reads `.claude/skills/` and
`.agents/skills/`.

Docs: https://opencode.ai/docs/skills/

## Codex CLI

```sh
follow-me install --harness codex
# manual
mkdir -p .agents/skills && cp -R /path/to/follow-me/skills/follow-me .agents/skills/
```

Type `$follow-me`, or describe the task and let Codex select the skill.

Docs: https://developers.openai.com/codex/skills

## Cursor

```sh
follow-me install --harness cursor
# manual
mkdir -p .cursor/skills && cp -R /path/to/follow-me/skills/follow-me .cursor/skills/
```

Type `/` in Agent chat and pick `follow-me`, or describe the task. Cursor also reads
`.agents/skills/` and `.claude/skills/`.

Docs: https://cursor.com/docs/context/skills

## Gemini CLI

```sh
follow-me install --harness gemini
# manual
mkdir -p .gemini/skills && cp -R /path/to/follow-me/skills/follow-me .gemini/skills/
```

Describe the task. Gemini CLI activates the skill itself and asks you to approve it first.
`.agents/skills/` works as an alias and wins over `.gemini/skills/` when both hold the skill.

Docs: https://geminicli.com/docs/cli/skills/

## GitHub Copilot CLI

```sh
follow-me install --harness copilot
# manual
mkdir -p .github/skills && cp -R /path/to/follow-me/skills/follow-me .github/skills/
```

Name the skill in your prompt: "Use the /follow-me skill to split this branch". Copilot also reads
`.claude/skills/` and `.agents/skills/` in a repo.

Docs: https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills

## Any other Agent Skills client

Clients that follow the open format scan `.agents/skills/` in the project and `~/.agents/skills/`
in your home directory.

```sh
follow-me install --harness agents
```

Docs: https://agentskills.io/client-implementation/adding-skills-support
