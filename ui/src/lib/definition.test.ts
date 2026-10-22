import { expect, test } from "vitest";
import { aCandidate, aCommit } from "../test/factories.ts";
import { definitionKeyHeld, identifierAt, isMac, labelOf, outcomeOf } from "./definition.ts";
import type { UnitId } from "./wire.ts";

const line = "  assertNumber(a, $b_2);";

test("the identifier under a caret, from its first letter to just past its last", () => {
  expect(identifierAt(line, 2)).toEqual({ name: "assertNumber", start: 2, end: 14 });
  expect(identifierAt(line, 8)?.name).toBe("assertNumber");
  // The caret after the last letter still means that word.
  expect(identifierAt(line, 14)?.name).toBe("assertNumber");
  expect(identifierAt(line, 18)).toEqual({ name: "$b_2", start: 18, end: 22 });
});

test("spaces, punctuation and numbers are no identifier", () => {
  expect(identifierAt(line, 0)).toBeNull();
  expect(identifierAt("a + 42;", 5)).toBeNull();
  expect(identifierAt("(", 0)).toBeNull();
  expect(identifierAt("", 0)).toBeNull();
  // The server takes ASCII names only, so a letter beyond ASCII ends the name.
  expect(identifierAt("café()", 1)?.name).toBe("caf");
});

test("Cmd goes to definition on macOS and Ctrl elsewhere", () => {
  expect(isMac("MacIntel")).toBe(true);
  expect(isMac("Linux x86_64")).toBe(false);
  expect(definitionKeyHeld({ metaKey: true, ctrlKey: false }, true)).toBe(true);
  expect(definitionKeyHeld({ metaKey: false, ctrlKey: true }, true)).toBe(false);
  expect(definitionKeyHeld({ metaKey: false, ctrlKey: true }, false)).toBe(true);
});

test("a candidate reads as path:line with its commit and section, or outside the branch", () => {
  const commits = [aCommit(0), aCommit(1, { section: "details" }), aCommit(2)];
  const unit: UnitId = JSON.parse('"h_000000000001"');
  expect(labelOf(aCandidate({ newLine: 3, unit, row: 0, commit: 1 }), commits)).toEqual({
    place: "src/guard.js:3",
    where: "in commit 2 · The details",
  });
  expect(labelOf(aCandidate({ unit, row: 0, commit: 2 }), commits).where).toBe("in commit 3");
  expect(labelOf(aCandidate(), commits)).toEqual({
    place: "src/guard.js:1",
    where: "outside this branch",
  });
});

test("one shown candidate jumps, one elsewhere peeks, several ask, none does nothing", () => {
  const unit: UnitId = JSON.parse('"h_000000000001"');
  const shown = aCandidate({ unit, row: 0, commit: 1 });
  const elsewhere = aCandidate();
  expect(outcomeOf([])).toEqual({ kind: "none" });
  expect(outcomeOf([shown])).toEqual({ kind: "jump", candidate: shown });
  expect(outcomeOf([elsewhere])).toEqual({ kind: "peek", candidate: elsewhere });
  expect(outcomeOf([shown, elsewhere])).toEqual({
    kind: "choose",
    candidates: [shown, elsewhere],
  });
});
