import { expect, test } from "vitest";
import { aCommit } from "../test/factories.ts";
import {
  describeEntry,
  groupsOf,
  indexOpenAtStart,
  type Marks,
  progressOf,
  unreadByCommit,
} from "./outline.ts";
import type { Notice } from "./unread.ts";

const none: Marks = { viewed: false, open: 0, waiting: 0, unread: 0, undecided: 0 };

test("commits group by section in document order, and a plan without sections is one list", () => {
  const sectioned = [
    aCommit(0, { section: "story" }),
    aCommit(1, { section: "steps" }),
    aCommit(2, { section: "steps" }),
    aCommit(3, { section: "wiring" }),
  ];
  expect(groupsOf(sectioned).map((g) => [g.section, g.commits.map((c) => c.index)])).toEqual([
    ["story", [0]],
    ["steps", [1, 2]],
    ["wiring", [3]],
  ]);
  const flat = groupsOf([aCommit(0), aCommit(1)]);
  expect(flat).toHaveLength(1);
  expect(flat[0]?.section).toBeNull();
});

test("an entry names its number, title and every mark, counted in words", () => {
  const commit = aCommit(3, { message: "Guard add\n\nbody" });
  expect(describeEntry(commit, none)).toBe("4 · Guard add");
  expect(describeEntry(commit, { ...none, undecided: 1 })).toBe("4 · Guard add · 1 agent concern");
  expect(
    describeEntry(commit, { viewed: true, open: 2, waiting: 1, unread: 1, undecided: 2 }),
  ).toBe("4 · Guard add · viewed · 2 open threads · 1 unread agent reply · 2 agent concerns");
});

test("the progress line counts viewed commits and open threads across the branch", () => {
  expect(progressOf([{ ...none, viewed: true }, none, none])).toBe("1 of 3 viewed");
  expect(
    progressOf([
      { ...none, viewed: true, open: 1 },
      { ...none, open: 1 },
    ]),
  ).toBe("1 of 2 viewed · 2 open threads");
});

test("unread replies count on the commit their thread sits in; plan notices do not", () => {
  const notice = (key: string, thread: string | null, kind: Notice["kind"] = "reply"): Notice =>
    JSON.parse(JSON.stringify({ key, kind, thread, preview: "" }));
  const where = new Map([
    ["c_aaaaaa", 1],
    ["c_bbbbbb", 1],
  ]);
  const unread = [
    notice("1", "c_aaaaaa"),
    notice("2", "c_bbbbbb", "explain"),
    notice("3", "c_cccccc"),
    notice("4", "c_aaaaaa", "version"),
  ];
  expect([...unreadByCommit(unread, where)]).toEqual([[1, 2]]);
});

test("the index opens by itself on a wide viewport until the reviewer chooses", () => {
  expect(indexOpenAtStart(new Set(), 1280)).toBe(true);
  expect(indexOpenAtStart(new Set(), 1279)).toBe(false);
  expect(indexOpenAtStart(new Set(["closed"]), 1600)).toBe(false);
  expect(indexOpenAtStart(new Set(["open"]), 900)).toBe(true);
});
