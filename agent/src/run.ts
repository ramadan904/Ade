import { parseArgs } from "node:util";
import { formatUnits, getAddress, isAddress, type Address } from "viem";
import { factoryAbi, vaultAbi } from "./abi.js";
import { connect, envNumber, loadEnv } from "./config.js";
import { executeOrders } from "./execute.js";
import { claudePlan, guardPlan, rulesPlan, type Plan } from "./plan.js";
import { readVault, shortError, type VaultState } from "./vault.js";

const USAGE = `Stockpilot agent

  npm run agent -- --vault 0x...        run once for one vault
  npm run agent -- --all                run once for every vault that names this agent
  npm run agent -- --all --loop 3600    keep running, once an hour

Options:
  --planner claude|rules   default: claude when ANTHROPIC_API_KEY or an ant profile is set, else rules
  --dry-run                plan and simulate, sign nothing
  --json                   print one JSON object per vault instead of text

Environment (agent/.env): RPC_URL, AGENT_PRIVATE_KEY, ANTHROPIC_API_KEY, AGENT_MODEL,
AGENT_SLIPPAGE_BPS (default 50), AGENT_MIN_ORDER_USD (default 1)`;

async function main() {
  loadEnv();
  const { values } = parseArgs({
    options: {
      vault: { type: "string", multiple: true },
      all: { type: "boolean", default: false },
      planner: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      loop: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || (!values.all && !values.vault?.length)) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }
  const planner = values.planner ?? (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_PROFILE ? "claude" : "rules");
  if (planner !== "claude" && planner !== "rules") throw new Error(`--planner must be claude or rules`);

  const ctx = await connect("AGENT_PRIVATE_KEY");
  const log = (line: string) => values.json || console.log(line);
  log(`agent ${ctx.account.address} on ${ctx.chain.name} (${ctx.chain.id}), planner: ${planner}${values["dry-run"] ? ", dry run" : ""}`);

  const once = async () => {
    const vaults = values.all ? await myVaults(ctx, ctx.account.address) : values.vault!.map((v) => checked(v));
    if (vaults.length === 0) log("no vaults name this agent yet");
    for (const vault of vaults) {
      try {
        await runVault(ctx, vault, planner, values["dry-run"], values.json, log);
      } catch (err) {
        log(`  ${vault}: failed: ${shortError(err)}`);
      }
    }
  };

  await once();
  if (values.loop) {
    const every = Number(values.loop);
    if (!(every >= 10)) throw new Error("--loop takes seconds, at least 10");
    for (;;) {
      await new Promise((r) => setTimeout(r, every * 1000));
      await once();
    }
  }
}

async function runVault(
  ctx: Awaited<ReturnType<typeof connect>>,
  vault: Address,
  plannerName: string,
  dryRun: boolean,
  json: boolean,
  log: (s: string) => void,
) {
  const state = await readVault(ctx.publicClient, vault, { fromBlock: BigInt(ctx.deployment.deployedAtBlock) });
  const usd = (n: bigint) => `$${Number(formatUnits(n, state.usdDecimals)).toFixed(2)}`;
  log(`\nvault ${vault}  owner ${state.owner}`);
  log(`  cash ${usd(state.usdBalance)}, budget left ${usd(state.remainingBudget)} until ${new Date(state.periodEndsAt * 1000).toISOString()}`);

  if (state.agent.toLowerCase() !== ctx.account.address.toLowerCase()) {
    log(`  skipped: this vault's agent is ${state.agent}, not us`);
    return;
  }
  if (state.paused) {
    log("  skipped: paused by the owner");
    return;
  }

  let plan: Plan;
  if (plannerName === "claude") {
    try {
      plan = await claudePlan(state, { model: process.env.AGENT_MODEL || undefined });
    } catch (err) {
      log(`  Claude planner failed (${shortError(err)}); falling back to the rules planner`);
      plan = rulesPlan(state);
    }
  } else {
    plan = rulesPlan(state);
  }
  log(`  plan (${plan.planner}): ${plan.summary}`);

  const guarded = guardPlan(plan, state, envNumber("AGENT_MIN_ORDER_USD", 1));
  for (const r of guarded.rejected) log(`  dropped ${r.order.symbol} $${r.order.usd}: ${r.why}`);

  const result = await executeOrders(ctx, state, guarded.accepted, {
    slippageBps: envNumber("AGENT_SLIPPAGE_BPS", 50),
    dryRun,
  });
  for (const f of result.fills) {
    const a = state.assets.find((x) => x.symbol === f.symbol)!;
    log(`  ${dryRun ? "would buy" : "bought"} ${formatUnits(f.received, a.decimals)} ${f.symbol} for ${usd(f.usdIn)}${dryRun ? "" : `  tx ${f.tx}`}`);
  }
  for (const f of result.failures) log(`  failed ${f.order.symbol} ${usd(f.order.usdIn)}: ${f.error}`);

  if (json) {
    console.log(
      JSON.stringify({
        vault,
        planner: plan.planner,
        summary: plan.summary,
        orders: plan.orders,
        rejected: guarded.rejected,
        fills: result.fills.map((f) => ({ ...f, usdIn: f.usdIn.toString(), received: f.received.toString() })),
        failures: result.failures.map((f) => ({ symbol: f.order.symbol, usdIn: f.order.usdIn.toString(), error: f.error })),
      }),
    );
  }
  return state satisfies VaultState;
}

async function myVaults(ctx: Awaited<ReturnType<typeof connect>>, agent: Address): Promise<Address[]> {
  const f = { address: ctx.deployment.factory, abi: factoryAbi } as const;
  const count = await ctx.publicClient.readContract({ ...f, functionName: "vaultCount" });
  const mine: Address[] = [];
  for (let start = 0n; start < count; start += 100n) {
    const page = await ctx.publicClient.readContract({ ...f, functionName: "vaults", args: [start, 100n] });
    const agents = await Promise.all(
      page.map((v) => ctx.publicClient.readContract({ address: v, abi: vaultAbi, functionName: "agent" })),
    );
    page.forEach((v, i) => agents[i]!.toLowerCase() === agent.toLowerCase() && mine.push(v));
  }
  return mine;
}

function checked(v: string): Address {
  if (!isAddress(v)) throw new Error(`not an address: ${v}`);
  return getAddress(v);
}

main().catch((err) => {
  console.error(shortError(err));
  process.exit(1);
});
