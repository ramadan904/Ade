import { formatUnits, parseUnits, type Address, type PublicClient } from "viem";
import { erc20Abi, marketAbi, vaultAbi } from "./abi.js";

export interface AssetView {
  address: Address;
  symbol: string;
  decimals: number;
  allowed: boolean;
  /** Units held by the vault. */
  balance: bigint;
  /** What one dollar of the vault's dollar token buys now (asset units), or null if the market has no usable price. */
  unitsPerDollar: bigint | null;
  /** Dollars per whole token, spread included, as a float for display and planning. */
  price: number | null;
  /** Why there is no price, when there is none (stale, unlisted). */
  priceError?: string;
}

export interface FillView {
  symbol: string;
  usd: number;
  units: number;
  price: number;
  memo: string;
  block: bigint;
  tx: `0x${string}`;
}

export interface VaultState {
  address: Address;
  owner: Address;
  agent: Address;
  market: Address;
  usd: Address;
  usdSymbol: string;
  usdDecimals: number;
  paused: boolean;
  strategy: string;
  policy: { maxPerTrade: bigint; budgetPerPeriod: bigint; period: number; maxSlippageBps: number };
  remainingBudget: bigint;
  periodEndsAt: number;
  usdBalance: bigint;
  assets: AssetView[];
  recentFills: FillView[];
  now: number;
}

export async function readVault(
  client: PublicClient,
  vault: Address,
  opts: { fromBlock?: bigint; maxFills?: number } = {},
): Promise<VaultState> {
  const v = { address: vault, abi: vaultAbi } as const;
  const [owner, agent, market, usd, paused, strategy, policy, remainingBudget, periodEndsAt, assetList, block] =
    await Promise.all([
      client.readContract({ ...v, functionName: "owner" }),
      client.readContract({ ...v, functionName: "agent" }),
      client.readContract({ ...v, functionName: "market" }),
      client.readContract({ ...v, functionName: "usd" }),
      client.readContract({ ...v, functionName: "paused" }),
      client.readContract({ ...v, functionName: "strategy" }),
      client.readContract({ ...v, functionName: "policy" }),
      client.readContract({ ...v, functionName: "remainingBudget" }),
      client.readContract({ ...v, functionName: "periodEndsAt" }),
      client.readContract({ ...v, functionName: "assets" }),
      client.getBlock(),
    ]);

  const [usdSymbol, usdDecimals, usdBalance] = await Promise.all([
    client.readContract({ address: usd, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: usd, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address: usd, abi: erc20Abi, functionName: "balanceOf", args: [vault] }),
  ]);
  const oneDollar = parseUnits("1", usdDecimals);
  // Quote a round amount so integer rounding does not distort the price.
  const probe = oneDollar * 100n;

  const assets = await Promise.all(
    assetList.map(async (address): Promise<AssetView> => {
      const [symbol, decimals, allowed, balance] = await Promise.all([
        client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
        client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
        client.readContract({ ...v, functionName: "isAllowed", args: [address] }),
        client.readContract({ address, abi: erc20Abi, functionName: "balanceOf", args: [vault] }),
      ]);
      try {
        const out = await client.readContract({
          address: market,
          abi: marketAbi,
          functionName: "quoteBuy",
          args: [address, probe],
        });
        const units = Number(formatUnits(out, decimals));
        return {
          address,
          symbol,
          decimals,
          allowed,
          balance,
          unitsPerDollar: out / 100n,
          price: units > 0 ? 100 / units : null,
        };
      } catch (err) {
        return { address, symbol, decimals, allowed, balance, unitsPerDollar: null, price: null, priceError: shortError(err) };
      }
    }),
  );

  const bySymbol = new Map(assets.map((a) => [a.address.toLowerCase(), a]));
  const logs = await client.getContractEvents({
    address: vault,
    abi: vaultAbi,
    eventName: "Bought",
    fromBlock: opts.fromBlock ?? 0n,
    toBlock: "latest",
  });
  const recentFills = logs.slice(-(opts.maxFills ?? 20)).map((log): FillView => {
    const a = bySymbol.get(log.args.asset!.toLowerCase());
    const decimals = a?.decimals ?? 18;
    const usdAmount = Number(formatUnits(log.args.usdIn!, usdDecimals));
    const units = Number(formatUnits(log.args.assetOut!, decimals));
    return {
      symbol: a?.symbol ?? log.args.asset!,
      usd: usdAmount,
      units,
      price: units > 0 ? usdAmount / units : 0,
      memo: log.args.memo ?? "",
      block: log.blockNumber,
      tx: log.transactionHash,
    };
  });

  return {
    address: vault,
    owner,
    agent,
    market,
    usd,
    usdSymbol,
    usdDecimals,
    paused,
    strategy,
    policy: {
      maxPerTrade: policy[0],
      budgetPerPeriod: policy[1],
      period: policy[2],
      maxSlippageBps: policy[3],
    },
    remainingBudget,
    periodEndsAt: Number(periodEndsAt),
    usdBalance,
    assets,
    recentFills,
    now: Number(block.timestamp),
  };
}

export function shortError(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string; cause?: { data?: { errorName?: string; args?: unknown[] } } };
  const data = e.cause?.data;
  if (data?.errorName) return `${data.errorName}(${(data.args ?? []).map(String).join(", ")})`;
  return (e.shortMessage ?? e.message ?? String(err)).split("\n")[0]!;
}
