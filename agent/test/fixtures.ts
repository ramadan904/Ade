import type { VaultState } from "../src/vault.js";

const D = 10n ** 6n;

export function fakeState(over: Partial<VaultState> = {}): VaultState {
  return {
    address: "0x00000000000000000000000000000000000000aa",
    owner: "0x00000000000000000000000000000000000000bb",
    agent: "0x00000000000000000000000000000000000000cc",
    market: "0x00000000000000000000000000000000000000dd",
    usd: "0x00000000000000000000000000000000000000ee",
    usdSymbol: "tUSD",
    usdDecimals: 6,
    paused: false,
    strategy: "Buy TSLA and AMZN weekly.",
    policy: { maxPerTrade: 50n * D, budgetPerPeriod: 100n * D, period: 7 * 86400, maxSlippageBps: 100 },
    remainingBudget: 100n * D,
    periodEndsAt: 1_760_604_800,
    usdBalance: 1_000n * D,
    assets: [
      { address: "0x0000000000000000000000000000000000000001", symbol: "TSLA", decimals: 18, allowed: true, balance: 0n, unitsPerDollar: 4n * 10n ** 15n, price: 250 },
      { address: "0x0000000000000000000000000000000000000002", symbol: "AMZN", decimals: 18, allowed: true, balance: 0n, unitsPerDollar: 5n * 10n ** 15n, price: 180 },
      { address: "0x0000000000000000000000000000000000000003", symbol: "NFLX", decimals: 18, allowed: false, balance: 0n, unitsPerDollar: 10n ** 15n, price: 600 },
      { address: "0x0000000000000000000000000000000000000004", symbol: "PLTR", decimals: 18, allowed: true, balance: 0n, unitsPerDollar: null, price: null, priceError: "StalePrice(...)" },
    ],
    recentFills: [],
    now: 1_760_000_000,
    ...over,
  };
}

export const DOLLAR = D;
