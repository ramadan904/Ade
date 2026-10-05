import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil, arbitrum, arbitrumSepolia } from "viem/chains";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "..", "..");

/** Loads agent/.env if present. Real environment variables win. */
export function loadEnv(): void {
  const file = path.join(repoRoot, "agent", ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com/rpc"] } },
  blockExplorers: { default: { name: "Explorer", url: "https://explorer.testnet.chain.robinhood.com" } },
  testnet: true,
});

export const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Explorer", url: "https://explorer.chain.robinhood.com" } },
});

const CHAINS: Chain[] = [anvil, robinhoodTestnet, robinhood, arbitrumSepolia, arbitrum];

export interface Deployment {
  chainId: number;
  deployedAtBlock: number;
  usd: Address;
  usdSymbol: string;
  market: Address;
  factory: Address;
  keeper: Address;
  testTokens: boolean;
  stocks: Record<string, Address>;
}

export function loadDeployment(chainId: number): Deployment {
  const file = process.env.DEPLOYMENT ?? path.join(repoRoot, "contracts", "deployments", `${chainId}.json`);
  if (!existsSync(file)) {
    throw new Error(`No deployment for chain ${chainId} (looked for ${file}). Run the deploy script first.`);
  }
  return JSON.parse(readFileSync(file, "utf8")) as Deployment;
}

export async function connect(privateKeyVar: string) {
  const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545";
  const probe = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await probe.getChainId();
  const chain =
    CHAINS.find((c) => c.id === chainId) ??
    defineChain({
      id: chainId,
      name: `Chain ${chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const key = process.env[privateKeyVar];
  if (!key) throw new Error(`${privateKeyVar} is not set (see agent/.env.example).`);
  const account = privateKeyToAccount(key as Hex);
  const walletClient = createWalletClient({ chain, account, transport: http(rpcUrl) });
  return { chain, publicClient, walletClient, account, deployment: loadDeployment(chainId) };
}

export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}
