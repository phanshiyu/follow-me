import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlanReply, PlanRequest, Send } from "./anthropic.ts";
import { PlanRequestError, requestPlan } from "./anthropic.ts";

const PLAN = {
  schema: "follow-me/plan@1",
  base: "a",
  tip: "b",
  commits: [{ message: "m", units: ["h_0123456789ab"] }],
  responses: [],
};

const reply = (overrides: Partial<PlanReply>): PlanReply => ({
  stopReason: "end_turn",
  text: JSON.stringify(PLAN),
  refusalExplanation: null,
  ...overrides,
});

test("a finished reply is parsed and the request carries the prompt and model", async () => {
  const seen: PlanRequest[] = [];
  const send: Send = async (request) => {
    seen.push(request);
    return reply({});
  };
  assert.deepEqual(await requestPlan("the prompt", { send, model: "claude-test" }), PLAN);
  assert.deepEqual(seen, [{ model: "claude-test", prompt: "the prompt" }]);
});

test("the default model is claude-opus-5-5", async () => {
  let model = "";
  await requestPlan("p", {
    send: async (request) => {
      model = request.model;
      return reply({});
    },
  });
  assert.equal(model, "claude-opus-5-5");
});

test("a refusal throws a typed error that carries the explanation", async () => {
  const send: Send = async () =>
    reply({ stopReason: "refusal", text: "", refusalExplanation: "policy" });
  await assert.rejects(requestPlan("p", { send }), (error) => {
    assert.ok(error instanceof PlanRequestError);
    assert.equal(error.failure, "refusal");
    assert.equal(error.message, "the model declined to write a plan: policy");
    return true;
  });
});

test("max_tokens, empty text and non-JSON each throw their own failure", async () => {
  const failureOf = async (overrides: Partial<PlanReply>) => {
    try {
      await requestPlan("p", { send: async () => reply(overrides) });
    } catch (error) {
      return error instanceof PlanRequestError ? error.failure : "other";
    }
    return "none";
  };
  assert.equal(await failureOf({ stopReason: "max_tokens", text: '{"schema"' }), "truncated");
  assert.equal(await failureOf({ text: "  " }), "empty");
  assert.equal(await failureOf({ text: "Here is your plan: {}" }), "not-json");
});
