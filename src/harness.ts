import { join } from "node:path";

export type Scope = "project" | "user";

/**
 * Every harness below reads SKILL.md as-is, so one format covers the table. A harness that
 * needs a rendered file (a Cursor rule, an AGENTS.md pointer) would add a variant here and
 * `plannedInstall` would branch on it.
 */
export type SkillFormat = "skill";

export type Harness = {
  readonly id: string;
  readonly name: string;
  /** Skills directory relative to the repo root. */
  readonly projectDir: string;
  /** Skills directory relative to the home directory. */
  readonly userDir: string;
  readonly format: SkillFormat;
  /** Home-relative directories whose presence means the harness is installed. */
  readonly probes: readonly string[];
  readonly docs: string;
};

export const SKILL_NAME = "follow-me";

export const HARNESSES: readonly Harness[] = [
  {
    id: "claude",
    name: "Claude Code",
    projectDir: ".claude/skills",
    userDir: ".claude/skills",
    format: "skill",
    probes: [".claude"],
    docs: "https://code.claude.com/docs/en/skills",
  },
  {
    id: "opencode",
    name: "OpenCode",
    projectDir: ".opencode/skills",
    userDir: ".config/opencode/skills",
    format: "skill",
    probes: [".config/opencode", ".opencode"],
    docs: "https://opencode.ai/docs/skills/",
  },
  {
    id: "codex",
    name: "Codex CLI",
    projectDir: ".agents/skills",
    userDir: ".agents/skills",
    format: "skill",
    probes: [".codex"],
    docs: "https://developers.openai.com/codex/skills",
  },
  {
    id: "cursor",
    name: "Cursor",
    projectDir: ".cursor/skills",
    userDir: ".cursor/skills",
    format: "skill",
    probes: [".cursor"],
    docs: "https://cursor.com/docs/context/skills",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    projectDir: ".gemini/skills",
    userDir: ".gemini/skills",
    format: "skill",
    probes: [".gemini"],
    docs: "https://geminicli.com/docs/cli/skills/",
  },
  {
    id: "copilot",
    name: "GitHub Copilot CLI",
    projectDir: ".github/skills",
    userDir: ".copilot/skills",
    format: "skill",
    probes: [".copilot"],
    docs: "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills",
  },
  {
    id: "agents",
    name: "Any Agent Skills client",
    projectDir: ".agents/skills",
    userDir: ".agents/skills",
    format: "skill",
    probes: [],
    docs: "https://agentskills.io/client-implementation/adding-skills-support",
  },
];

export function findHarness(id: string): Harness | undefined {
  return HARNESSES.find((h) => h.id === id);
}

export type PlannedFile = {
  /** Absolute destination. */
  readonly path: string;
  /** Path inside the skill folder that supplies the content. */
  readonly source: string;
};

export function plannedInstall(
  harness: Harness,
  scope: Scope,
  home: string,
  repoRoot: string,
): readonly PlannedFile[] {
  const root = scope === "user" ? join(home, harness.userDir) : join(repoRoot, harness.projectDir);
  return [{ path: join(root, SKILL_NAME, "SKILL.md"), source: "SKILL.md" }];
}
