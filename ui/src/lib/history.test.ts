import { expect, test } from "vitest";
import { backLabel, HISTORY_LIMIT, type History, popDeparture, pushDeparture } from "./history.ts";

test("Back retraces jumps last first, named by the commit clicked in, then has nowhere to go", () => {
  let history: History = [];
  expect(backLabel(history)).toBeNull();
  history = pushDeparture(history, { spot: { commit: 0, offset: 120 }, from: 1 });
  history = pushDeparture(history, { spot: { commit: 5, offset: 0 }, from: 5 });
  expect(backLabel(history)).toBe("Back to commit 6");

  const first = popDeparture(history);
  expect(first?.spot).toEqual({ commit: 5, offset: 0 });
  history = first?.rest ?? [];
  expect(backLabel(history)).toBe("Back to commit 2");

  const second = popDeparture(history);
  expect(second?.spot).toEqual({ commit: 0, offset: 120 });
  expect(popDeparture(second?.rest ?? [])).toBeNull();
});

test("the oldest departures fall off past the limit", () => {
  let history: History = [];
  for (let i = 0; i < HISTORY_LIMIT + 3; i += 1)
    history = pushDeparture(history, { spot: { commit: i, offset: 0 }, from: i });
  expect(history).toHaveLength(HISTORY_LIMIT);
  expect(history[0]?.from).toBe(3);
});
