import { expect, test } from "vitest";
import { aCommit, aHunk } from "../test/factories.ts";
import { bodyOf, commitKey, filesOf, hunkHeader, noteOf, titleOf } from "./commit.ts";
import type { Unit, UnitId } from "./wire.ts";

test("a message splits into its title and body", () => {
  expect(titleOf("Guard add\n\nadd now rejects strings.")).toBe("Guard add");
  expect(bodyOf("Guard add\n\nadd now rejects strings.")).toBe("add now rejects strings.");
  expect(bodyOf("Guard add")).toBe("");
});

test("the agent's note is hidden when it repeats the body", () => {
  expect(noteOf(aCommit(0, { message: "T\n\nSame  words.", narration: "same words." }))).toBeNull();
  expect(noteOf(aCommit(0, { message: "T\n\nBody.", narration: " Look at the guard. " }))).toBe(
    "Look at the guard.",
  );
  expect(noteOf(aCommit(0, { narration: "  " }))).toBeNull();
});

test("units group by file and the key changes with the selection", () => {
  const hunk = aHunk();
  const units = new Map<UnitId, Unit>([[hunk.id, hunk]]);
  const commit = aCommit(0, { refs: [{ unit: hunk.id, select: { kind: "lines", changes: [0] } }] });
  expect(filesOf(commit, units).map((f) => [f.path, f.parts.length])).toEqual([["src/lib.js", 1]]);
  const moved = aCommit(0, {
    refs: [{ unit: hunk.id, select: { kind: "lines", changes: [0, 1] } }],
  });
  expect(commitKey(moved)).not.toBe(commitKey(commit));
});

test("the hunk header gives each side's start and length", () => {
  expect(
    hunkHeader([
      { old: 3, new: 3 },
      { old: null, new: 4 },
      { old: 4, new: null },
    ]),
  ).toBe("@@ -3,2 +3,2 @@");
});
