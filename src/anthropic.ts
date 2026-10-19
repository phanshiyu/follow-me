import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_MODEL = "claude-opus-5-5";
const MAX_TOKENS = 64000;

/** The part of a model reply the planner cares about, independent of the SDK's message types. */
export type PlanReply = {
  readonly stopReason: string | null;
  readonly text: string;
  readonly refusalExplanation: string | null;
};

export type PlanRequest = {
  readonly model: string;
  readonly prompt: string;
};

export type Send = (request: PlanRequest) => Promise<PlanReply>;

export type PlanRequestFailure = "refusal" | "truncated" | "empty" | "not-json";

export class PlanRequestError extends Error {
  readonly failure: PlanRequestFailure;
  constructor(failure: PlanRequestFailure, message: string) {
    super(message);
    this.name = "PlanRequestError";
    this.failure = failure;
  }
}

const optionalText = { anyOf: [{ type: "string" }, { type: "null" }] };
const annotatedUnit = {
  type: "object",
  properties: { unit: { type: "string" }, narration: optionalText, diagram: optionalText },
  required: ["unit", "narration", "diagram"],
  additionalProperties: false,
};
const unitList = { type: "array", items: { anyOf: [{ type: "string" }, annotatedUnit] } };

/**
 * Mirrors PlanFile on the wire. Structured outputs need every property required and closed
 * objects, so narration and diagram are nullable instead of optional; the plan parser reads null
 * as none.
 */
export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    schema: { type: "string", enum: ["follow-me/plan@1"] },
    base: { type: "string" },
    tip: { type: "string" },
    commits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          message: { type: "string" },
          narration: optionalText,
          diagram: optionalText,
          units: unitList,
        },
        required: ["message", "narration", "diagram", "units"],
        additionalProperties: false,
      },
    },
    responses: {
      type: "array",
      items: {
        type: "object",
        properties: {
          comment: { type: "string" },
          status: { type: "string", enum: ["addressed", "declined", "deferred"] },
          note: { type: "string" },
        },
        required: ["comment", "status", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["schema", "base", "tip", "commits", "responses"],
  additionalProperties: false,
};

const sendWithAnthropic: Send = async ({ model, prompt }) => {
  const client = new Anthropic();
  // Streaming because a 64k-token reply outlives the SDK's non-streaming timeout.
  const stream = client.beta.messages.stream({
    model,
    max_tokens: MAX_TOKENS,
    output_config: { effort: "high", format: { type: "json_schema", schema: PLAN_SCHEMA } },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    messages: [{ role: "user", content: prompt }],
  });
  const message = await stream.finalMessage();
  const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
  return {
    stopReason: message.stop_reason,
    text: text.join(""),
    refusalExplanation: message.stop_details?.explanation ?? null,
  };
};

/**
 * Asks the model for a plan and returns the parsed JSON. The caller validates it as a plan,
 * because a schema-conforming reply can still name units that do not exist.
 */
export async function requestPlan(
  prompt: string,
  opts: { model?: string; send?: Send } = {},
): Promise<unknown> {
  const send = opts.send ?? sendWithAnthropic;
  const reply = await send({ model: opts.model ?? DEFAULT_MODEL, prompt });
  if (reply.stopReason === "refusal") {
    const why = reply.refusalExplanation ? `: ${reply.refusalExplanation}` : "";
    throw new PlanRequestError("refusal", `the model declined to write a plan${why}`);
  }
  if (reply.stopReason === "max_tokens") {
    throw new PlanRequestError(
      "truncated",
      `the plan did not fit in ${MAX_TOKENS} tokens; try a smaller diff`,
    );
  }
  if (reply.text.trim() === "") {
    throw new PlanRequestError("empty", "the model returned no text");
  }
  try {
    return JSON.parse(reply.text);
  } catch {
    throw new PlanRequestError("not-json", "the model's reply was not valid JSON");
  }
}
