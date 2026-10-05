import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { after, before, test } from "node:test";
import { createPublicClient, createWalletClient, http, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil } from "viem/chains";
import { erc20Abi, vaultAbi } from "../src/abi.js";
import { loadDeployment, repoRoot } from "../src/config.js";
import { executeOrders } from "../src/execute.js";
import { readVault } from "../src/vault.js";

// Anvil's well-known dev keys: 0 deploys and keeps prices, 1 owns a vault, 2 is the agent.
const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  owner: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  agent: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
} as const;
const PORT = 8600 + Math.floor(Math.random() * 300);
const RPC_URL = `http://127.0.0.1:${PORT}`;
const agentAccount = privateKeyToAccount(KEYS.agent);
const haveTools = ["anvil", "forge"].every((bin) => spawnSync(bin, ["--version"]).status === 0);

let node: ChildProcess | undefined;
const env = {
  ...process.env,
  RPC_URL,
  OWNER_PRIVATE_KEY: KEYS.owner,
  AGENT_PRIVATE_KEY: KEYS.agent,
  KEEPER_PRIVATE_KEY: KEYS.deployer,
  ANTHROPIC_API_KEY: "",
};
const publicClient = createPublicClient({ chain: anvil, transport: http(RPC_URL) });
const agentWallet = createWalletClient({ chain: anvil, account: agentAccount, transport: http(RPC_URL) });

function cli(script: string, args: string[]): string {
  return execFileSync("npx", ["tsx", path.join("src", script), ...args], {
    cwd: path.join(repoRoot, "agent"),
    env,
    encoding: "utf8",
  });
}

before(async () => {
  if (!haveTools) return;
  node = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      await publicClient.getChainId();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  execFileSync(
    "forge",
    ["script", "script/Deploy.s.sol", "--offline", "--rpc-url", RPC_URL, "--broadcast", "--private-key", KEYS.deployer],
    { cwd: path.join(repoRoot, "contracts"), stdio: "ignore" },
  );
});

after(() => node?.kill());

test("end to end on a local chain: open a vault, let the agent buy, try to break the rules", { skip: !haveTools && "needs anvil and forge" }, async () => {
  const d = loadDeployment(31337);
  const balanceOf = (token: Address, who: Address) =>
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });

  // 1. The owner opens a vault: $500 in, $50 per order, $100 a week, TSLA and AMZN only.
  const vault = cli("create-vault.ts", [
    "--agent", agentAccount.address, "--deposit", "500", "--per-trade", "50", "--budget", "100",
    "--period", "7d", "--assets", "TSLA,AMZN", "--strategy", "Split evenly between TSLA and AMZN.",
  ]).trim() as Address;
  assert.match(vault, /^0x[0-9a-fA-F]{40}$/);

  // 2. The agent finds the vault by itself and spends this week's budget.
  const out = cli("run.ts", ["--all", "--planner", "rules"]);
  assert.match(out, /bought .* TSLA for \$50\.00/);
  assert.match(out, /bought .* AMZN for \$50\.00/);
  assert.ok((await balanceOf(d.stocks.TSLA!, vault)) > 0n);
  assert.equal(await balanceOf(d.usd, vault), parseUnits("400", 6));

  // 3. Run again the same week: nothing left to spend, nothing happens.
  assert.match(cli("run.ts", ["--vault", vault, "--planner", "rules"]), /Nothing to do/);

  // 4. A compromised agent skips its own guard and sends bad orders straight to the vault.
  const state = await readVault(publicClient, vault);
  const nflx = d.stocks.NFLX!;
  const rogue = await executeOrders(
    { publicClient, walletClient: agentWallet, account: agentAccount, chain: anvil },
    { ...state, assets: [...state.assets, { ...state.assets[0]!, address: nflx, symbol: "NFLX", allowed: true }] },
    [
      { symbol: "NFLX", usd: 10, usdIn: parseUnits("10", 6), reason: "not allowed" },
      { symbol: "TSLA", usd: 400, usdIn: parseUnits("400", 6), reason: "too big" },
      { symbol: "TSLA", usd: 10, usdIn: parseUnits("10", 6), reason: "over budget" },
    ],
    { slippageBps: 50 },
  );
  assert.equal(rogue.fills.length, 0);
  assert.match(rogue.failures[0]!.error, /^AssetNotAllowed/);
  assert.match(rogue.failures[1]!.error, /^OverTradeLimit/);
  assert.match(rogue.failures[2]!.error, /^OverBudget/);

  // ...and tries to take the money. There is no function for it; withdraw is owner-only.
  await assert.rejects(
    publicClient.simulateContract({
      account: agentAccount,
      address: vault,
      abi: vaultAbi,
      functionName: "withdraw",
      args: [d.usd, parseUnits("400", 6), agentAccount.address],
    }),
    /NotOwner/,
  );
  assert.equal(await balanceOf(d.usd, vault), parseUnits("400", 6));
  assert.equal(await balanceOf(d.usd, agentAccount.address), 0n);

  // 5. A week later (with fresh prices) the budget is back and the agent buys again.
  await publicClient.request({ method: "evm_increaseTime" as never, params: [7 * 86400] as never });
  await publicClient.request({ method: "evm_mine" as never, params: [] as never });
  cli("keeper.ts", ["--refresh"]);
  assert.match(cli("run.ts", ["--vault", vault, "--planner", "rules"]), /bought .* TSLA/);
  assert.equal(await balanceOf(d.usd, vault), parseUnits("300", 6));

  // 6. The owner pauses: the agent stands down.
  const ownerWallet = createWalletClient({ chain: anvil, account: privateKeyToAccount(KEYS.owner as Hex), transport: http(RPC_URL) });
  const hash = await ownerWallet.writeContract({ address: vault, abi: vaultAbi, functionName: "setPaused", args: [true] });
  await publicClient.waitForTransactionReceipt({ hash });
  assert.match(cli("run.ts", ["--vault", vault, "--planner", "rules"]), /paused by the owner/);
});
