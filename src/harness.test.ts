import assert from "node:assert/strict";
import { test } from "node:test";
import { findHarness, HARNESSES, plannedInstall } from "./harness.ts";

const HOME = "/home/u";
const REPO = "/work/repo";

const EXPECTED: Record<string, { project: string; user: string }> = {
  claude: {
    project: "/work/repo/.claude/skills/follow-me/SKILL.md",
    user: "/home/u/.claude/skills/follow-me/SKILL.md",
  },
  opencode: {
    project: "/work/repo/.opencode/skills/follow-me/SKILL.md",
    user: "/home/u/.config/opencode/skills/follow-me/SKILL.md",
  },
  codex: {
    project: "/work/repo/.agents/skills/follow-me/SKILL.md",
    user: "/home/u/.agents/skills/follow-me/SKILL.md",
  },
  cursor: {
    project: "/work/repo/.cursor/skills/follow-me/SKILL.md",
    user: "/home/u/.cursor/skills/follow-me/SKILL.md",
  },
  gemini: {
    project: "/work/repo/.gemini/skills/follow-me/SKILL.md",
    user: "/home/u/.gemini/skills/follow-me/SKILL.md",
  },
  copilot: {
    project: "/work/repo/.github/skills/follow-me/SKILL.md",
    user: "/home/u/.copilot/skills/follow-me/SKILL.md",
  },
  agents: {
    project: "/work/repo/.agents/skills/follow-me/SKILL.md",
    user: "/home/u/.agents/skills/follow-me/SKILL.md",
  },
};

test("every harness has literal project and user paths", () => {
  assert.deepEqual(HARNESSES.map((h) => h.id).sort(), Object.keys(EXPECTED).sort());
  for (const harness of HARNESSES) {
    const want = EXPECTED[harness.id];
    assert.ok(want, harness.id);
    assert.deepEqual(plannedInstall(harness, "project", HOME, REPO), [
      { path: want.project, source: "SKILL.md" },
    ]);
    assert.deepEqual(plannedInstall(harness, "user", HOME, REPO), [
      { path: want.user, source: "SKILL.md" },
    ]);
  }
});

test("findHarness looks up by id", () => {
  assert.equal(findHarness("cursor")?.name, "Cursor");
  assert.equal(findHarness("emacs"), undefined);
});
