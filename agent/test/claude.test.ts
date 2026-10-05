import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { claudePlan } from "../src/plan.js";
import { fakeState } from "./fixtures.js";

function fakeClient(response: object, seen: { params?: any }) {
  return {
    beta: {
      messages: {
        parse: async (params: unknown) => {
          seen.params = params;
          return response;
        },
      },
    },
  } as unknown as Anthropic;
}

test("asks Claude with the strategy, the state and a structured output format", async () => {
  const seen: { params?: any } = {};
  const plan = await claudePlan(fakeState({ strategy: "Only TSLA, $20 a week." }), {
    client: fakeClient(
      { stop_reason: "end_turn", parsed_output: { summary: "One TSLA buy.", orders: [{ symbol: "TSLA", usd: 20, reason: "weekly" }] } },
      seen,
    ),
  });
  assert.equal(plan.planner, "claude");
  assert.deepEqual(plan.orders, [{ symbol: "TSLA", usd: 20, reason: "weekly" }]);

  const p = seen.params;
  assert.equal(p.model, "claude-opus-5-5");
  assert.equal(p.fallbacks, "default");
  assert.deepEqual(p.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(p.output_config.effort, "medium");
  assert.equal(p.output_config.format.type, "json_schema");
  const text = p.messages[0].content.map((c: { text: string }) => c.text).join("\n");
  assert.match(text, /<owner_strategy>\nOnly TSLA, \$20 a week\.\n<\/owner_strategy>/);
  assert.match(text, /"remaining_this_period_usd": 100/);
  assert.doesNotMatch(text, /NFLX/, "disallowed assets are not shown to the model");
});

test("a refusal or an unparsable answer is an error, so the caller falls back", async () => {
  await assert.rejects(claudePlan(fakeState(), { client: fakeClient({ stop_reason: "refusal", parsed_output: null }, {}) }), /declined/);
  await assert.rejects(claudePlan(fakeState(), { client: fakeClient({ stop_reason: "end_turn", parsed_output: null }, {}) }), /schema/);
});
