import { parseArgs } from "node:util";
import { formatUnits, parseUnits, type Address } from "viem";
import { marketAbi } from "./abi.js";
import { connect, loadEnv } from "./config.js";
import { shortError } from "./vault.js";

const USAGE = `Stockpilot price keeper for the demo OracleMarket

  npm run keeper -- --set TSLA=251.20,AMZN=179.90   post these prices once
  npm run keeper -- --refresh                       re-post current prices (keeps them from going stale)
  npm run keeper -- --demo --every 60               random walk (+/-1.5%) every 60 s, for demos

Environment: RPC_URL, KEEPER_PRIVATE_KEY`;

async function main() {
  loadEnv();
  const { values } = parseArgs({
    options: {
      set: { type: "string" },
      refresh: { type: "boolean", default: false },
      demo: { type: "boolean", default: false },
      every: { type: "string", default: "60" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || (!values.set && !values.refresh && !values.demo)) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }
  const ctx = await connect("KEEPER_PRIVATE_KEY");
  const stocks = Object.entries(ctx.deployment.stocks) as [string, Address][];

  const current = async () =>
    Promise.all(
      stocks.map(async ([symbol, address]) => {
        const [price] = await ctx.publicClient.readContract({
          address: ctx.deployment.market,
          abi: marketAbi,
          functionName: "quotes",
          args: [address],
        });
        return { symbol, address, price };
      }),
    );

  const post = async (updates: { symbol: string; address: Address; price: bigint }[]) => {
    const hash = await ctx.walletClient.writeContract({
      address: ctx.deployment.market,
      abi: marketAbi,
      functionName: "setPrices",
      args: [updates.map((u) => u.address), updates.map((u) => u.price)],
      chain: ctx.chain,
      account: ctx.account,
    });
    await ctx.publicClient.waitForTransactionReceipt({ hash });
    console.log(
      `${new Date().toISOString()}  ${updates.map((u) => `${u.symbol} $${formatUnits(u.price, 8)}`).join("  ")}  tx ${hash}`,
    );
  };

  if (values.set) {
    const updates = values.set.split(",").map((pair) => {
      const [symbol, value] = pair.split("=");
      const hit = stocks.find(([s]) => s.toUpperCase() === symbol?.trim().toUpperCase());
      if (!hit || !value) throw new Error(`unknown symbol or missing price in "${pair}"`);
      return { symbol: hit[0], address: hit[1], price: parseUnits(value.trim(), 8) };
    });
    await post(updates);
    return;
  }
  if (values.refresh) {
    await post((await current()).filter((q) => q.price > 0n));
    return;
  }
  for (;;) {
    const moved = (await current())
      .filter((q) => q.price > 0n)
      .map((q) => {
        const bps = BigInt(Math.round((Math.random() * 2 - 1) * 150));
        return { ...q, price: (q.price * (10_000n + bps)) / 10_000n };
      });
    await post(moved);
    await new Promise((r) => setTimeout(r, Number(values.every) * 1000));
  }
}

main().catch((err) => {
  console.error(shortError(err));
  process.exit(1);
});
