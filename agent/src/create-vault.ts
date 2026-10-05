import { parseArgs } from "node:util";
import { getAddress, parseUnits, parseEventLogs, type Address } from "viem";
import { erc20Abi, factoryAbi } from "./abi.js";
import { connect, loadEnv } from "./config.js";
import { shortError } from "./vault.js";

const USAGE = `Open a Stockpilot vault from the command line (the web app does the same)

  npm run create-vault -- --agent 0x... --deposit 500 --per-trade 50 --budget 100 --period 7d \\
    --assets TSLA,AMZN --strategy "Buy TSLA and AMZN every week, more of whichever is down."

On a deployment with test tokens, missing test dollars are minted to you first.
Environment: RPC_URL, OWNER_PRIVATE_KEY`;

function seconds(s: string): number {
  const m = /^(\d+)([smhd])$/.exec(s.trim());
  if (!m) throw new Error(`--period like 7d, 24h or 3600s, got "${s}"`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "s" | "m" | "h" | "d"];
}

async function main() {
  loadEnv();
  const { values } = parseArgs({
    options: {
      agent: { type: "string" },
      deposit: { type: "string", default: "500" },
      "per-trade": { type: "string", default: "50" },
      budget: { type: "string", default: "100" },
      period: { type: "string", default: "7d" },
      slippage: { type: "string", default: "100" },
      assets: { type: "string", default: "TSLA,AMZN" },
      strategy: { type: "string", default: "Buy steadily every week, splitting evenly." },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || !values.agent) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }
  const ctx = await connect("OWNER_PRIVATE_KEY");
  const d = ctx.deployment;
  const usdDecimals = await ctx.publicClient.readContract({ address: d.usd, abi: erc20Abi, functionName: "decimals" });
  const dollars = (s: string) => parseUnits(s, usdDecimals);
  const assets = values.assets.split(",").map((sym) => {
    const hit = Object.entries(d.stocks).find(([s]) => s.toUpperCase() === sym.trim().toUpperCase());
    if (!hit) throw new Error(`${sym} is not in this deployment (have: ${Object.keys(d.stocks).join(", ")})`);
    return hit[1] as Address;
  });
  const deposit = dollars(values.deposit);
  const me = ctx.account.address;
  const send = async (req: Parameters<typeof ctx.walletClient.writeContract>[0]) => {
    const hash = await ctx.walletClient.writeContract(req);
    return ctx.publicClient.waitForTransactionReceipt({ hash });
  };

  const balance = await ctx.publicClient.readContract({ address: d.usd, abi: erc20Abi, functionName: "balanceOf", args: [me] });
  if (balance < deposit) {
    if (!d.testTokens) throw new Error(`you hold less than ${values.deposit} ${d.usdSymbol}`);
    await send({ address: d.usd, abi: erc20Abi, functionName: "mint", args: [me, deposit - balance], chain: ctx.chain, account: ctx.account });
  }
  if (deposit > 0n) {
    await send({ address: d.usd, abi: erc20Abi, functionName: "approve", args: [d.factory, deposit], chain: ctx.chain, account: ctx.account });
  }
  const receipt = await send({
    address: d.factory,
    abi: factoryAbi,
    functionName: "createVault",
    args: [
      getAddress(values.agent),
      {
        maxPerTrade: dollars(values["per-trade"]),
        budgetPerPeriod: dollars(values.budget),
        period: seconds(values.period),
        maxSlippageBps: Number(values.slippage),
      },
      assets,
      values.strategy,
      deposit,
    ],
    chain: ctx.chain,
    account: ctx.account,
  });
  const [created] = parseEventLogs({ abi: factoryAbi, logs: receipt.logs, eventName: "VaultCreated" });
  console.log(created!.args.vault);
}

main().catch((err) => {
  console.error(shortError(err));
  process.exit(1);
});
