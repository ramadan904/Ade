import assert from "node:assert/strict";
import { test } from "node:test";
import { guardPlan, MAX_ORDERS_PER_RUN, rulesPlan, snapshot } from "../src/plan.js";
import { DOLLAR, fakeState } from "./fixtures.js";

test("accepts orders inside every limit", () => {
  const r = guardPlan({ orders: [{ symbol: "TSLA", usd: 40, reason: "weekly" }, { symbol: "amzn", usd: 10.555, reason: "dip" }] }, fakeState());
  assert.deepEqual(r.rejected, []);
  assert.deepEqual(r.accepted.map((o) => [o.symbol, o.usdIn]), [["TSLA", 40n * DOLLAR], ["AMZN", 10_550_000n]]);
});

test("drops assets the owner did not allow, unknown symbols and unpriced assets", () => {
  const r = guardPlan(
    { orders: [{ symbol: "NFLX", usd: 10, reason: "" }, { symbol: "DOGE", usd: 10, reason: "" }, { symbol: "PLTR", usd: 10, reason: "" }] },
    fakeState(),
  );
  assert.equal(r.accepted.length, 0);
  assert.match(r.rejected[0]!.why, /not on the owner's allowlist/);
  assert.match(r.rejected[1]!.why, /not on the owner's allowlist/);
  assert.match(r.rejected[2]!.why, /no usable price.*StalePrice/);
});

test("cuts an order to the per-trade cap and the total to the remaining budget", () => {
  const r = guardPlan(
    { orders: [{ symbol: "TSLA", usd: 500, reason: "" }, { symbol: "AMZN", usd: 500, reason: "" }, { symbol: "TSLA", usd: 5, reason: "" }] },
    fakeState(),
  );
  assert.deepEqual(r.accepted.map((o) => o.usdIn), [50n * DOLLAR, 50n * DOLLAR]);
  assert.match(r.rejected[0]!.why, /budget or balance exhausted/);
});

test("never plans more than the vault holds", () => {
  const r = guardPlan({ orders: [{ symbol: "TSLA", usd: 50, reason: "" }] }, fakeState({ usdBalance: 12n * DOLLAR }));
  assert.equal(r.accepted[0]!.usdIn, 12n * DOLLAR);
});

test("rejects non-positive and non-numeric amounts, and dust", () => {
  const r = guardPlan(
    { orders: [{ symbol: "TSLA", usd: -5, reason: "" }, { symbol: "TSLA", usd: Number.NaN, reason: "" }, { symbol: "TSLA", usd: 0.5, reason: "" }] },
    fakeState(),
  );
  assert.equal(r.accepted.length, 0);
  assert.match(r.rejected[2]!.why, /below the \$1 minimum/);
});

test("caps the number of orders per run", () => {
  const orders = Array.from({ length: MAX_ORDERS_PER_RUN + 2 }, () => ({ symbol: "TSLA", usd: 1, reason: "" }));
  const r = guardPlan({ orders }, fakeState());
  assert.equal(r.accepted.length, MAX_ORDERS_PER_RUN);
  assert.equal(r.rejected.length, 2);
});

test("a paused vault gets no orders", () => {
  const r = guardPlan({ orders: [{ symbol: "TSLA", usd: 10, reason: "" }] }, fakeState({ paused: true }));
  assert.equal(r.accepted.length, 0);
  assert.equal(r.rejected[0]!.why, "vault is paused");
});

test("memos are one line and fit the on-chain limit", () => {
  const r = guardPlan({ orders: [{ symbol: "TSLA", usd: 10, reason: "line one\nline two " + "x".repeat(400) }] }, fakeState());
  const memo = r.accepted[0]!.reason;
  assert.ok(!memo.includes("\n"));
  assert.ok(Buffer.byteLength(memo) <= 280);
});

test("rules planner splits the remaining budget over allowed, priced assets", () => {
  const plan = rulesPlan(fakeState({ remainingBudget: 70n * DOLLAR }));
  assert.deepEqual(plan.orders.map((o) => [o.symbol, o.usd]), [["TSLA", 35], ["AMZN", 35]]);
  assert.equal(rulesPlan(fakeState({ remainingBudget: 0n })).orders.length, 0);
});

test("the model sees only allowed assets, in dollars", () => {
  const s = snapshot(fakeState());
  assert.deepEqual(s.assets.map((a) => a.symbol), ["TSLA", "AMZN", "PLTR"]);
  assert.equal(s.limits.max_per_order_usd, 50);
  assert.equal(s.cash_usd, 1000);
  assert.equal(s.limits.period_days, 7);
});
