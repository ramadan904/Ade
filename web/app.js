import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  custom,
  erc20Abi,
  factoryAbi,
  formatUnits,
  getAddress,
  http,
  isAddress,
  marketAbi,
  parseUnits,
  privateKeyToAccount,
  vaultAbi,
} from "./vendor/lib.js";

// ------------------------------------------------------------------ config

const NETWORKS = {
  31337: { name: "Local chain", rpc: new URLSearchParams(location.search).get("rpc") ?? "http://127.0.0.1:8545", explorer: null },
  46630: {
    name: "Robinhood Chain Testnet",
    rpc: "https://rpc.testnet.chain.robinhood.com/rpc",
    explorer: "https://explorer.testnet.chain.robinhood.com",
  },
  421614: { name: "Arbitrum Sepolia", rpc: "https://sepolia-rollup.arbitrum.io/rpc", explorer: "https://sepolia.arbiscan.io" },
};
const PREFERRED_CHAIN = 46630;

// Anvil's public dev keys. Used only on the local chain, where no wallet extension is needed.
const DEV_OWNER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const DEV_AGENT = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

const PRESETS = {
  steady: "Buy every week, split evenly across my stocks. Spread the buys over the week instead of all at once.",
  dip: "Buy every week. Put most of the budget into whichever stock is furthest below what I last paid for it. If nothing is down, buy a little of each.",
  tilt: "Favour the tech names: put about two thirds of each week's budget into TSLA and PLTR and the rest into the others.",
};

const WEEK = 7 * 86400;
// Display order, and the two picked by default when opening a vault.
const ORDER = ["TSLA", "AMZN", "PLTR", "NFLX", "AMD"];
const DEFAULT_PICKS = new Set(["TSLA", "AMZN"]);

// ------------------------------------------------------------------ state

const S = {
  chainId: 0,
  chain: null,
  deployment: null,
  pc: null,
  wc: null,
  account: null,
  dev: false,
  usdDecimals: 6,
  usdSymbol: "USD",
  stocks: [], // [{ symbol, address, decimals }]
  vault: null,
  view: null, // latest dashboard read
  timer: 0,
  busy: false,
};

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ connect

async function connect() {
  const btn = $("connect");
  btn.disabled = true;
  try {
    const local = ["localhost", "127.0.0.1"].includes(location.hostname);
    const forceDev = new URLSearchParams(location.search).has("dev");
    if (window.ethereum && !forceDev) {
      await connectInjected();
    } else if (local || forceDev) {
      await connectDev();
    } else {
      alert("Install a browser wallet (MetaMask, Rabby, Coinbase Wallet) to use Stockpilot.");
      return;
    }
    await afterConnect();
  } catch (err) {
    console.error(err);
    alert(explain(err));
  } finally {
    btn.disabled = false;
  }
}

async function connectInjected() {
  const eth = window.ethereum;
  const [addr] = await eth.request({ method: "eth_requestAccounts" });
  let chainId = Number(await eth.request({ method: "eth_chainId" }));
  if (!NETWORKS[chainId]) {
    await switchChain(PREFERRED_CHAIN);
    chainId = PREFERRED_CHAIN;
  }
  S.chainId = chainId;
  S.chain = chainFor(chainId);
  S.account = getAddress(addr);
  S.pc = createPublicClient({ chain: S.chain, transport: custom(eth) });
  S.wc = createWalletClient({ chain: S.chain, account: S.account, transport: custom(eth) });
  eth.on?.("accountsChanged", () => location.reload());
  eth.on?.("chainChanged", () => location.reload());
}

async function switchChain(id) {
  const n = NETWORKS[id];
  const hex = "0x" + id.toString(16);
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (err) {
    if (err?.code !== 4902) throw err;
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: hex,
        chainName: n.name,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: [n.rpc],
        blockExplorerUrls: n.explorer ? [n.explorer] : [],
      }],
    });
  }
}

async function connectDev() {
  const account = privateKeyToAccount(DEV_OWNER_KEY);
  S.dev = true;
  S.chainId = 31337;
  S.chain = chainFor(31337);
  S.account = account.address;
  S.pc = createPublicClient({ chain: S.chain, transport: http(NETWORKS[31337].rpc) });
  S.wc = createWalletClient({ chain: S.chain, account, transport: http(NETWORKS[31337].rpc) });
}

function chainFor(id) {
  const n = NETWORKS[id];
  return {
    id,
    name: n.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [n.rpc] } },
  };
}

async function afterConnect() {
  const res = await fetch(`../contracts/deployments/${S.chainId}.json`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Stockpilot is not deployed on ${NETWORKS[S.chainId].name} yet.`);
  S.deployment = await res.json();
  const d = S.deployment;
  [S.usdDecimals, S.usdSymbol] = await Promise.all([
    S.pc.readContract({ address: d.usd, abi: erc20Abi, functionName: "decimals" }),
    S.pc.readContract({ address: d.usd, abi: erc20Abi, functionName: "symbol" }),
  ]);
  S.stocks = await Promise.all(
    Object.entries(d.stocks).map(async ([symbol, address]) => ({
      symbol,
      address: getAddress(address),
      decimals: await S.pc.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
    })),
  );
  const rank = (sym) => (ORDER.includes(sym) ? ORDER.indexOf(sym) : ORDER.length);
  S.stocks.sort((a, b) => rank(a.symbol) - rank(b.symbol) || a.symbol.localeCompare(b.symbol));
  document.querySelectorAll(".usd-symbol").forEach((e) => (e.textContent = S.usdSymbol));

  $("connect").hidden = true;
  $("account").hidden = false;
  $("account").textContent = (S.dev ? "dev " : "") + short(S.account);
  $("network").hidden = false;
  $("network").textContent = NETWORKS[S.chainId].name;
  $("landing").hidden = true;

  const vaults = await S.pc.readContract({ address: d.factory, abi: factoryAbi, functionName: "vaultsOf", args: [S.account] });
  if (vaults.length) await showDashboard(vaults[vaults.length - 1]);
  else await showCreate();
}

// ------------------------------------------------------------------ prices

async function prices() {
  const out = {};
  await Promise.all(
    S.stocks.map(async (s) => {
      try {
        const [price, updatedAt] = await S.pc.readContract({
          address: S.view?.market ?? S.deployment.market,
          abi: marketAbi,
          functionName: "quotes",
          args: [s.address],
        });
        out[s.symbol] = { price: Number(formatUnits(price, 8)), updatedAt: Number(updatedAt) };
      } catch {
        out[s.symbol] = { price: null, updatedAt: 0 };
      }
    }),
  );
  return out;
}

// ------------------------------------------------------------------ create

async function showCreate() {
  $("create").hidden = false;
  $("dashboard").hidden = true;
  const px = await prices();
  const box = $("f-assets");
  const known = S.stocks.some((s) => DEFAULT_PICKS.has(s.symbol));
  box.replaceChildren(
    ...S.stocks.map((s, i) =>
      assetPick(s, px[s.symbol]?.price, known ? DEFAULT_PICKS.has(s.symbol) : i < 2, null),
    ),
  );
  $("f-agent").value = S.deployment.agent ?? (S.chainId === 31337 ? DEV_AGENT : "");
  $("f-agent-note").textContent = S.deployment.agent || S.chainId === 31337
    ? "Prefilled with the Stockpilot agent for this network. You can run your own instead."
    : "Enter the address of the agent that will trade for you.";
  $("mint").hidden = !S.deployment.testTokens;
  await refreshBalance();
}

function assetPick(stock, price, checked, onChange) {
  const input = el("input", { type: "checkbox", value: stock.address });
  input.checked = checked;
  if (onChange) input.addEventListener("change", () => onChange(stock, input));
  return el(
    "label",
    { class: "asset" },
    input,
    el("span", {}, el("b", {}, stock.symbol), el("small", {}, price ? usdFmt(price) : "no price")),
  );
}

async function refreshBalance() {
  const bal = await S.pc.readContract({ address: S.deployment.usd, abi: erc20Abi, functionName: "balanceOf", args: [S.account] });
  $("f-balance").textContent = `${num(formatUnits(bal, S.usdDecimals))} ${S.usdSymbol}`;
  return bal;
}

async function mintTestDollars() {
  await run($("create-status"), async (say) => {
    say("Minting 1,000 test dollars…");
    await send({ address: S.deployment.usd, abi: erc20Abi, functionName: "mint", args: [S.account, dollars("1000")] });
    await refreshBalance();
    return "Added 1,000 test dollars to your wallet.";
  });
}

async function createVault(ev) {
  ev.preventDefault();
  await run($("create-status"), async (say) => {
    const d = S.deployment;
    const assets = [...$("f-assets").querySelectorAll("input:checked")].map((i) => i.value);
    if (!assets.length) throw new Error("Pick at least one stock.");
    const agent = $("f-agent").value.trim();
    if (!isAddress(agent)) throw new Error("The agent address is not valid.");
    const perTrade = dollars($("f-per-trade").value);
    const budget = dollars($("f-budget").value);
    if (perTrade > budget) throw new Error("Max per trade can't be more than the weekly budget.");
    const deposit = dollars($("f-deposit").value || "0");

    if (deposit > 0n) {
      const bal = await refreshBalance();
      if (bal < deposit) throw new Error(`You hold less than ${$("f-deposit").value} ${S.usdSymbol}.`);
      const allowance = await S.pc.readContract({ address: d.usd, abi: erc20Abi, functionName: "allowance", args: [S.account, d.factory] });
      if (allowance < deposit) {
        say("Step 1 of 2: allow the deposit…");
        await send({ address: d.usd, abi: erc20Abi, functionName: "approve", args: [d.factory, deposit] });
      }
    }
    say(deposit > 0n ? "Step 2 of 2: create and fund your vault…" : "Creating your vault…");
    await send({
      address: d.factory,
      abi: factoryAbi,
      functionName: "createVault",
      args: [
        getAddress(agent),
        { maxPerTrade: perTrade, budgetPerPeriod: budget, period: WEEK, maxSlippageBps: Number($("f-slippage").value) },
        assets,
        $("f-strategy").value.trim(),
        deposit,
      ],
    });
    const vaults = await S.pc.readContract({ address: d.factory, abi: factoryAbi, functionName: "vaultsOf", args: [S.account] });
    await showDashboard(vaults[vaults.length - 1]);
    return "Vault created.";
  });
}

// ------------------------------------------------------------------ dashboard

async function showDashboard(vault) {
  S.vault = getAddress(vault);
  $("d-address").textContent = S.vault;
  await refreshDashboard(true);
  $("create").hidden = true;
  $("dashboard").hidden = false;
  clearInterval(S.timer);
  S.timer = setInterval(() => !S.busy && refreshDashboard(false).catch(console.error), 8000);
}

async function readVaultView() {
  const v = { address: S.vault, abi: vaultAbi };
  const r = (functionName, args) => S.pc.readContract({ ...v, functionName, args });
  const [agent, market, paused, strategy, policy, remaining, endsAt, assetList, cash] = await Promise.all([
    r("agent"), r("market"), r("paused"), r("strategy"), r("policy"), r("remainingBudget"), r("periodEndsAt"), r("assets"),
    S.pc.readContract({ address: S.deployment.usd, abi: erc20Abi, functionName: "balanceOf", args: [S.vault] }),
  ]);
  const allowed = new Set();
  await Promise.all(assetList.map(async (a) => (await r("isAllowed", [a])) && allowed.add(getAddress(a))));
  const balances = {};
  await Promise.all(
    S.stocks.map(async (s) => {
      balances[s.symbol] = await S.pc.readContract({ address: s.address, abi: erc20Abi, functionName: "balanceOf", args: [S.vault] });
    }),
  );
  const logs = await S.pc.getContractEvents({
    address: S.vault,
    abi: vaultAbi,
    eventName: "Bought",
    fromBlock: BigInt(S.deployment.deployedAtBlock ?? 0),
    toBlock: "latest",
  });
  const recent = logs.slice(-25);
  const times = {};
  await Promise.all(
    [...new Set(recent.map((l) => l.blockNumber))].map(async (n) => {
      times[n] = Number((await S.pc.getBlock({ blockNumber: n })).timestamp);
    }),
  );
  return { agent, market, paused, strategy, policy, remaining, endsAt: Number(endsAt), allowed, cash, balances, fills: recent, times };
}

async function refreshDashboard(fillForms) {
  const [view, px] = await Promise.all([readVaultView(), prices()]);
  S.view = view;
  const bySym = Object.fromEntries(S.stocks.map((s) => [s.address.toLowerCase(), s]));
  const cash = Number(formatUnits(view.cash, S.usdDecimals));

  // average cost from the agent's own fills
  const cost = {};
  for (const l of view.fills) {
    const s = bySym[l.args.asset.toLowerCase()];
    if (!s) continue;
    const c = (cost[s.symbol] ??= { usd: 0, units: 0 });
    c.usd += Number(formatUnits(l.args.usdIn, S.usdDecimals));
    c.units += Number(formatUnits(l.args.assetOut, s.decimals));
  }

  let invested = 0;
  const rows = [];
  for (const s of S.stocks) {
    const units = Number(formatUnits(view.balances[s.symbol], s.decimals));
    if (units <= 0) continue;
    const price = px[s.symbol]?.price;
    const value = price ? units * price : 0;
    invested += value;
    const avg = cost[s.symbol]?.units ? cost[s.symbol].usd / cost[s.symbol].units : null;
    const change = price && avg ? (price - avg) / avg : null;
    rows.push(
      el("tr", {},
        el("td", {}, el("b", {}, s.symbol)),
        el("td", { class: "num" }, units.toFixed(4)),
        el("td", { class: "num" }, price ? usdFmt(price) : "–"),
        el("td", { class: "num" }, avg ? usdFmt(avg) : "–",
          change === null ? "" : el("small", { class: change >= 0 ? "up" : "down" }, ` ${change >= 0 ? "+" : ""}${(change * 100).toFixed(1)}%`)),
        el("td", { class: "num" }, usdFmt(value)),
      ),
    );
  }
  $("d-holdings").querySelector("tbody").replaceChildren(...rows);
  $("d-holdings-empty").hidden = rows.length > 0;

  const budget = Number(formatUnits(view.policy[1], S.usdDecimals));
  const left = Number(formatUnits(view.remaining, S.usdDecimals));
  $("d-total").textContent = usdFmt(cash + invested);
  $("d-cash").textContent = usdFmt(cash);
  $("d-invested").textContent = usdFmt(invested);
  $("d-budget").textContent = `${usdFmt(left)} / ${usdFmt(budget)}`;
  $("d-budget-bar").style.width = `${budget ? Math.min(100, (left / budget) * 100) : 0}%`;
  $("d-reset").textContent = `Refills ${relTime(view.endsAt)}`;

  const revoked = /^0x0{40}$/i.test(view.agent);
  const state = $("d-state");
  state.className = "pill " + (revoked ? "bad" : view.paused ? "warn" : "ok");
  state.textContent = revoked ? "No agent" : view.paused ? "Agent paused" : "Agent active";
  $("d-agent").textContent = revoked ? "none (revoked)" : view.agent;
  $("pause-btn").textContent = view.paused ? "Resume agent" : "Pause agent";

  // activity feed, newest first
  const feed = [...view.fills].reverse().map((l) => {
    const s = bySym[l.args.asset.toLowerCase()];
    const units = Number(formatUnits(l.args.assetOut, s?.decimals ?? 18));
    const spent = Number(formatUnits(l.args.usdIn, S.usdDecimals));
    const link = txLink(l.transactionHash);
    return el("li", {},
      el("div", { class: "what" }, `Bought ${units.toFixed(4)} ${s?.symbol ?? "?"} for ${usdFmt(spent)}`),
      l.args.memo ? el("div", { class: "why" }, l.args.memo) : "",
      el("div", { class: "meta" },
        `${relTime(view.times[l.blockNumber])} · ${usdFmt(spent / units)} per share · `,
        link ? el("a", { href: link, target: "_blank", rel: "noopener" }, "tx") : short(l.transactionHash),
      ),
    );
  });
  $("d-feed").replaceChildren(...feed);
  $("d-feed-empty").hidden = feed.length > 0;

  if (fillForms) {
    $("d-strategy").value = view.strategy;
    $("d-per-trade").value = Number(formatUnits(view.policy[0], S.usdDecimals));
    $("d-week").value = budget;
    $("d-slippage").value = view.policy[3];
    $("d-assets").replaceChildren(
      ...S.stocks.map((s) => assetPick(s, px[s.symbol]?.price, view.allowed.has(s.address), toggleAsset)),
    );
    $("d-withdraw-token").replaceChildren(
      el("option", { value: S.deployment.usd }, S.usdSymbol),
      ...S.stocks.map((s) => el("option", { value: s.address }, s.symbol)),
    );
  }
}

// ------------------------------------------------------------------ dashboard actions

const vaultTx = (functionName, args) => send({ address: S.vault, abi: vaultAbi, functionName, args });

const ACTIONS = {
  connect,
  "save-strategy": () => act(async () => {
    await vaultTx("setStrategy", [$("d-strategy").value.trim()]);
    return "Strategy saved. The agent reads it on its next run.";
  }),
  "save-policy": () => act(async () => {
    const perTrade = dollars($("d-per-trade").value);
    const week = dollars($("d-week").value);
    if (perTrade > week) throw new Error("Max per trade can't be more than the weekly budget.");
    await vaultTx("setPolicy", [{ maxPerTrade: perTrade, budgetPerPeriod: week, period: S.view.policy[2], maxSlippageBps: Number($("d-slippage").value) }]);
    return "Rules saved.";
  }),
  deposit: () => act(async (say) => {
    const amount = dollars($("d-deposit").value);
    const allowance = await S.pc.readContract({ address: S.deployment.usd, abi: erc20Abi, functionName: "allowance", args: [S.account, S.vault] });
    if (allowance < amount) {
      say("Allow the deposit…");
      await send({ address: S.deployment.usd, abi: erc20Abi, functionName: "approve", args: [S.vault, amount] });
    }
    say("Depositing…");
    await vaultTx("deposit", [amount]);
    return "Deposited.";
  }),
  withdraw: () => act(async () => {
    const token = $("d-withdraw-token").value;
    const bal = await S.pc.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [S.vault] });
    if (bal === 0n) throw new Error("The vault holds none of that.");
    await vaultTx("withdraw", [token, bal, S.account]);
    return "Withdrawn to your wallet.";
  }),
  "toggle-pause": () => act(async () => {
    await vaultTx("setPaused", [!S.view.paused]);
    return S.view.paused ? "Agent resumed." : "Agent paused. It can't trade until you resume it.";
  }),
  revoke: () => act(async () => {
    if (!confirm("Revoke the agent? It will not be able to trade until you set an agent again.")) return "";
    await vaultTx("setAgent", ["0x0000000000000000000000000000000000000000"]);
    return "Agent revoked.";
  }),
  "set-agent": () => act(async () => {
    const a = $("d-new-agent").value.trim();
    if (!isAddress(a)) throw new Error("Not a valid address.");
    await vaultTx("setAgent", [getAddress(a)]);
    $("d-new-agent").value = "";
    return "Agent updated.";
  }),
};

async function toggleAsset(stock, input) {
  const want = input.checked;
  await act(async () => {
    try {
      await vaultTx("setAsset", [stock.address, want]);
    } catch (err) {
      input.checked = !want;
      throw err;
    }
    return `${stock.symbol} ${want ? "allowed" : "removed"}.`;
  });
}

function act(fn) {
  return run($("d-status"), async (say) => {
    const msg = await fn(say);
    await refreshDashboard(true);
    return msg;
  });
}

// ------------------------------------------------------------------ tx plumbing

async function send(req) {
  const { request } = await S.pc.simulateContract({ account: S.wc.account, ...req });
  const hash = await S.wc.writeContract(request);
  const receipt = await S.pc.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction ${short(hash)} failed.`);
  return receipt;
}

async function run(statusEl, fn) {
  if (S.busy) return;
  S.busy = true;
  const buttons = document.querySelectorAll("button");
  buttons.forEach((b) => (b.disabled = true));
  const say = (msg, cls = "") => {
    statusEl.textContent = msg;
    statusEl.className = "status " + cls;
  };
  try {
    say("Working…");
    const msg = await fn(say);
    say(msg ?? "", "ok");
  } catch (err) {
    console.error(err);
    say(explain(err), "error");
  } finally {
    buttons.forEach((b) => (b.disabled = false));
    S.busy = false;
  }
}

const FRIENDLY = {
  NotOwner: "Only the vault's owner can do that.",
  InvalidPolicy: "Those rules aren't valid: max per trade must be above zero and at most the weekly budget, slippage at most 10%.",
  StrategyTooLong: "The strategy is too long (2,000 characters max).",
  InvalidAsset: "That token can't be allowed.",
  TooManyAssets: "A vault can list at most 32 tokens.",
  TokenCallFailed: "The token transfer failed. Check your balance and approval.",
};

function explain(err) {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    const name = revert?.data?.errorName;
    if (name) return FRIENDLY[name] ?? `${name}(${(revert.data.args ?? []).join(", ")})`;
    if (err.walk((e) => e?.code === 4001)) return "You rejected the request in your wallet.";
    return err.shortMessage;
  }
  return err?.message ?? String(err);
}

// ------------------------------------------------------------------ helpers

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) node.setAttribute(k, v);
  for (const c of children) if (c !== "" && c != null) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}
const dollars = (s) => parseUnits(String(s || "0"), S.usdDecimals);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const num = (s) => Number(s).toLocaleString(undefined, { maximumFractionDigits: 2 });
const usdFmt = (n) => "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const txLink = (h) => (NETWORKS[S.chainId]?.explorer ? `${NETWORKS[S.chainId].explorer}/tx/${h}` : null);

function relTime(ts) {
  if (!ts) return "";
  const diff = ts - Date.now() / 1000;
  const abs = Math.abs(diff);
  const [n, unit] = abs < 90 ? [Math.round(abs), "second"] : abs < 5400 ? [Math.round(abs / 60), "minute"] : abs < 129600 ? [Math.round(abs / 3600), "hour"] : [Math.round(abs / 86400), "day"];
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(diff < 0 ? -n : n, unit);
}

// ------------------------------------------------------------------ wire up

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (btn && ACTIONS[btn.dataset.action]) ACTIONS[btn.dataset.action]();
  const preset = e.target.closest("[data-preset]");
  if (preset) $("f-strategy").value = PRESETS[preset.dataset.preset];
});
$("connect").addEventListener("click", connect);
$("create-form").addEventListener("submit", createVault);
$("mint").addEventListener("click", mintTestDollars);
