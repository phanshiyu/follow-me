import { expect, test } from "vitest";
import { aHunk } from "../test/factories.ts";
import { nearRows, newRows, whatChanged } from "./whatChanged.ts";

test("two guards merged into one call show the old lines out and the new line in", () => {
  expect(
    whatChanged(["  assertNumber(a);", "  assertNumber(b);"], ["  assertNumbers(a, b);"]),
  ).toEqual({
    lines: [
      { op: "-", text: "  assertNumber(a);" },
      { op: "-", text: "  assertNumber(b);" },
      { op: "+", text: "  assertNumbers(a, b);" },
    ],
    more: 0,
  });
});

test("an unchanged line before the change stays as one line of lead-in", () => {
  const out = whatChanged(
    ["function add(a, b) {", "  return a + b;"],
    ["function add(a, b) {", "  return Number(a) + Number(b);"],
  );
  expect(out?.lines).toEqual([
    { op: " ", text: "function add(a, b) {" },
    { op: "-", text: "  return a + b;" },
    { op: "+", text: "  return Number(a) + Number(b);" },
  ]);
});

test("a long change stops at six lines and counts the rest", () => {
  const old = Array.from({ length: 5 }, (_, i) => `old ${i}`);
  const now = Array.from({ length: 5 }, (_, i) => `new ${i}`);
  const out = whatChanged(old, now);
  expect(out?.lines).toHaveLength(6);
  expect(out?.more).toBe(4);
});

test("nothing is shown when the lines are the same or there is nothing quoted", () => {
  expect(whatChanged(["a "], ["a"])).toBeNull();
  expect(whatChanged([], ["a"])).toBeNull();
});

test("nearRows takes the run of added rows around a place, or a context row alone", () => {
  const body = aHunk().body;
  expect(nearRows(body, 4)).toEqual([3, 4]);
  expect(nearRows(body, 0)).toEqual([0, 1]);
  expect(nearRows(body, 5)).toEqual([5]);
  expect(nearRows(body, 99)).toEqual([]);
});

test("newRows reads the picked rows the new plan still has", () => {
  const body = aHunk().body;
  expect(newRows(body, [2, 3, 99])).toEqual(["export function add(a, b) {", "  assertNumber(a);"]);
});
