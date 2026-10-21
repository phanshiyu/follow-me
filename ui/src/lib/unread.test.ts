import { describe, expect, test } from "vitest";
import { aComment, aReply, aState, HUNK } from "../test/factories.ts";
import { titleOfNotice, unreadOf } from "./unread.ts";
import type { ServerEvent } from "./wire.ts";

function event(raw: unknown): ServerEvent {
  return JSON.parse(JSON.stringify(raw));
}

const agentReply = event({
  seq: 1,
  type: "reply",
  commentId: "c_aaaaaa",
  reply: aReply({ id: JSON.parse('"r_1"'), body: "Because **a** is read first.\n\nSecond line." }),
});
const mine = event({
  seq: 2,
  type: "reply",
  commentId: "c_aaaaaa",
  reply: aReply({ id: JSON.parse('"r_2"'), author: "reviewer" }),
});
const explain = event({
  seq: 3,
  type: "comment",
  comment: aComment({
    id: JSON.parse('"c_expl00"'),
    author: "agent",
    anchor: { kind: "message", commit: 2 },
    body: "This commit moves the guards.",
  }),
});
const swap = event({
  seq: 4,
  type: "version",
  version: 3,
  hash: "h",
  carried: [
    {
      comment: aComment({ id: JSON.parse('"c_aaaaaa"') }),
      unit: HUNK,
      offsets: [3],
      changed: true,
      path: "src/lib.js",
      newLine: 16,
    },
    {
      comment: aComment({ id: JSON.parse('"c_bbbbbb"') }),
      unit: HUNK,
      offsets: [4],
      changed: false,
      path: "src/lib.js",
      newLine: 17,
    },
    {
      comment: aComment({ id: JSON.parse('"c_cccccc"') }),
      unit: null,
      offsets: null,
      changed: true,
      path: "src/old.js",
      newLine: null,
    },
  ],
});

describe("unreadOf", () => {
  test("agent replies, explanations and swaps that moved threads are unread; the reviewer's own are not", () => {
    const unread = unreadOf(new Set(), [agentReply, mine, explain, swap]);
    expect(unread.map((n) => n.key)).toEqual(["reply:r_1", "explain:c_expl00", "version:3"]);
    expect(unread[2]?.thread).toBe("c_aaaaaa");
    expect(unread[0]?.preview).toBe("Because **a** is read first. Second line.");
  });

  test("a replayed event counts once, and a seen key drops out", () => {
    expect(unreadOf(new Set(), [agentReply, agentReply])).toHaveLength(1);
    expect(unreadOf(new Set(["reply:r_1"]), [agentReply, explain]).map((n) => n.key)).toEqual([
      "explain:c_expl00",
    ]);
  });

  test("a swap that moved nothing is not news", () => {
    const quiet = event({ seq: 5, type: "version", version: 4, hash: "h", carried: [] });
    expect(
      unreadOf(new Set(), [quiet, event({ seq: 6, type: "version", version: 5, hash: "h" })]),
    ).toEqual([]);
  });
});

describe("titleOfNotice", () => {
  const state = aState({ comments: [aComment()] });
  test("a reply names the file and the line it sits on", () => {
    const [reply, , , version] = [agentReply, mine, explain, swap].map(
      (e) => unreadOf(new Set(), [e])[0],
    );
    if (reply === undefined || version === undefined) throw new Error("notices");
    expect(titleOfNotice(reply, state)).toBe("Agent replied on src/lib.js:4");
    expect(titleOfNotice(version, state)).toBe("Plan v3 arrived, 2 threads moved");
  });

  test("an explanation on a commit names the commit", () => {
    const [notice] = unreadOf(new Set(), [explain]);
    if (notice === undefined) throw new Error("notice");
    const withIt = aState({
      comments: [
        aComment({
          id: JSON.parse('"c_expl00"'),
          author: "agent",
          anchor: { kind: "message", commit: 2 },
        }),
      ],
    });
    expect(titleOfNotice(notice, withIt)).toBe("Agent explained commit 3");
  });
});
