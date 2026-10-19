import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findHarness,
  HARNESSES,
  type Harness,
  type PlannedFile,
  plannedInstall,
  type Scope,
  SKILL_NAME,
} from "./harness.ts";

/** Flags shared by `install` and `uninstall`; both resolve them to the same files. */
export type SkillTargets = {
  /** Comma-separated harness ids from `--harness`. */
  readonly harness: string | undefined;
  readonly all: boolean;
  readonly user: boolean;
  readonly dryRun: boolean;
};

export type InstallOptions = SkillTargets & { readonly list: boolean };

class InstallError extends Error {
  override readonly name = "InstallError";
}

/**
 * The skill folder ships next to `dist/` in the package and next to `src/` in a checkout, so
 * walk up from this module until a folder holds it.
 */
export function findSkillDir(from: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(from));
  for (;;) {
    const candidate = join(dir, "skills", SKILL_NAME);
    if (existsSync(join(candidate, "SKILL.md"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir)
      throw new InstallError(`cannot find skills/${SKILL_NAME} next to the package`);
    dir = parent;
  }
}

export function detectHarnesses(home: string): readonly Harness[] {
  return HARNESSES.filter((h) => h.probes.some((probe) => existsSync(join(home, probe))));
}

function chooseHarnesses(options: SkillTargets, home: string): readonly Harness[] {
  if (options.all && options.harness !== undefined) {
    throw new InstallError("use --all or --harness, not both");
  }
  if (options.all) return HARNESSES;
  if (options.harness !== undefined) {
    return options.harness.split(",").map((id) => {
      const found = findHarness(id.trim());
      if (!found) {
        const known = HARNESSES.map((h) => h.id).join(", ");
        throw new InstallError(`unknown harness "${id}" (known: ${known})`);
      }
      return found;
    });
  }
  const found = detectHarnesses(home);
  if (found.length === 0) {
    throw new InstallError(
      "no harness config directory found; pass --harness <id> or --all (see --list)",
    );
  }
  return found;
}

/**
 * The files install writes and uninstall removes. Harnesses that share a skills directory (Codex
 * and the generic one) plan the same file once.
 */
export function planSkillFiles(
  options: SkillTargets,
  home: string,
  repoRoot: string,
): readonly PlannedFile[] {
  const scope: Scope = options.user ? "user" : "project";
  const byPath = new Map<string, PlannedFile>();
  for (const harness of chooseHarnesses(options, home)) {
    for (const file of plannedInstall(harness, scope, home, repoRoot)) {
      byPath.set(file.path, file);
    }
  }
  return [...byPath.values()];
}

function writeSkill(skillDir: string, file: PlannedFile, dryRun: boolean): string {
  const content = readFileSync(join(skillDir, file.source));
  const current = existsSync(file.path) ? readFileSync(file.path) : null;
  if (current?.equals(content)) return `unchanged ${file.path}`;
  if (dryRun) return `would write ${file.path}`;
  mkdirSync(dirname(file.path), { recursive: true });
  writeFileSync(file.path, content);
  return `wrote ${file.path}`;
}

/** Removes the file and then its follow-me folder if that is left empty, never a parent. */
function removeSkill(file: PlannedFile, dryRun: boolean): string {
  if (!existsSync(file.path)) return `absent ${file.path}`;
  if (dryRun) return `would remove ${file.path}`;
  rmSync(file.path);
  const folder = dirname(file.path);
  if (basename(folder) === SKILL_NAME) {
    try {
      rmdirSync(folder);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOTEMPTY")) throw error;
    }
  }
  return `removed ${file.path}`;
}

function listTable(): string[] {
  return HARNESSES.flatMap((h) => [
    `${h.id}  ${h.name}`,
    `  project  ${h.projectDir}/${SKILL_NAME}/SKILL.md`,
    `  user     ~/${h.userDir}/${SKILL_NAME}/SKILL.md`,
    `  docs     ${h.docs}`,
  ]);
}

function reportingErrors(run: () => void): number {
  try {
    run();
    return 0;
  } catch (error) {
    if (!(error instanceof InstallError)) throw error;
    process.stderr.write(`follow-me: ${error.message}\n`);
    return 1;
  }
}

export function runInstall(
  options: InstallOptions,
  home: string,
  repoRoot: string,
  say: (line: string) => void,
  skillDir: string = findSkillDir(),
): number {
  return reportingErrors(() => {
    if (options.list) {
      for (const line of listTable()) say(line);
      return;
    }
    for (const file of planSkillFiles(options, home, repoRoot)) {
      say(writeSkill(skillDir, file, options.dryRun));
    }
  });
}

export function runUninstall(
  options: SkillTargets,
  home: string,
  repoRoot: string,
  say: (line: string) => void,
): number {
  return reportingErrors(() => {
    for (const file of planSkillFiles(options, home, repoRoot)) {
      say(removeSkill(file, options.dryRun));
    }
  });
}
