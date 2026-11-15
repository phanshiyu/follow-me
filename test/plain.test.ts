import assert from "node:assert/strict";
import { test } from "node:test";
import { plainNumber, plainText } from "../src/plain.ts";

test("text made of the allowed characters comes back unchanged, anything else throws", () => {
  assert.equal(plainText("/s/ab12/", "/sab12"), "/s/ab12/");
  assert.throws(() => plainText("/s/../x", "/sab12"), /unexpected character "\."/);
});

test("a whole number survives, and a negative, fractional or huge one throws", () => {
  assert.equal(plainNumber(4173), 4173);
  assert.throws(() => plainNumber(-1));
  assert.throws(() => plainNumber(1.5));
  assert.throws(() => plainNumber(1e21));
});
