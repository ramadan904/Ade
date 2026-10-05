import { decodeEventLog, type Account, type Address, type Chain, type PublicClient, type WalletClient } from "viem";
import { marketAbi, vaultAbi } from "./abi.js";
import type { GuardedOrder } from "./plan.js";
import { shortError, type VaultState } from "./vault.js";

export interface Fill {
  symbol: string;
  usdIn: bigint;
  received: bigint;
  tx: `0x${string}`;
}

export interface ExecResult {
  fills: Fill[];
  failures: { order: GuardedOrder; error: string }[];
}

/**
 * Places each order through the vault. Every order is simulated first, so a revert costs no gas and comes
 * back with the contract's own error name.
 */
export async function executeOrders(
  ctx: { publicClient: PublicClient; walletClient: WalletClient; account: Account; chain: Chain },
  state: VaultState,
  orders: GuardedOrder[],
  opts: { slippageBps: number; dryRun?: boolean },
): Promise<ExecResult> {
  const fills: Fill[] = [];
  const failures: ExecResult["failures"] = [];
  const slippage = BigInt(Math.min(opts.slippageBps, state.policy.maxSlippageBps));

  for (const order of orders) {
    const asset = state.assets.find((a) => a.symbol === order.symbol)!;
    try {
      const quote = await ctx.publicClient.readContract({
        address: state.market,
        abi: marketAbi,
        functionName: "quoteBuy",
        args: [asset.address, order.usdIn],
      });
      const minOut = (quote * (10_000n - slippage)) / 10_000n;
      const { request } = await ctx.publicClient.simulateContract({
        account: ctx.account,
        address: state.address,
        abi: vaultAbi,
        functionName: "buy",
        args: [asset.address, order.usdIn, minOut, order.reason],
      });
      if (opts.dryRun) {
        fills.push({ symbol: order.symbol, usdIn: order.usdIn, received: quote, tx: "0x" });
        continue;
      }
      const hash = await ctx.walletClient.writeContract({ ...request, chain: ctx.chain, account: ctx.account });
      const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
      const received = boughtAmount(receipt.logs, state.address);
      fills.push({ symbol: order.symbol, usdIn: order.usdIn, received, tx: hash });
    } catch (err) {
      failures.push({ order, error: shortError(err) });
    }
  }
  return { fills, failures };
}

function boughtAmount(logs: { address: Address; data: `0x${string}`; topics: `0x${string}`[] }[], vault: Address) {
  for (const log of logs) {
    if (log.address.toLowerCase() !== vault.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: vaultAbi, data: log.data, topics: log.topics as [`0x${string}`] });
      if (ev.eventName === "Bought" && ev.args) return ev.args.assetOut;
    } catch {
      // not a vault event we know
    }
  }
  return 0n;
}
