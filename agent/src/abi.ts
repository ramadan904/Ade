import { parseAbi } from "viem";

/** Errors a buy (or a vault created through the factory) can revert with, so they decode by name. */
const vaultErrors = [
  "error NotOwner()",
  "error NotAgent()",
  "error IsPaused()",
  "error ZeroAddress()",
  "error ZeroAmount()",
  "error AssetNotAllowed(address asset)",
  "error InvalidAsset(address asset)",
  "error TooManyAssets()",
  "error InvalidPolicy()",
  "error OverTradeLimit(uint256 amount, uint256 limit)",
  "error OverBudget(uint256 amount, uint256 remaining)",
  "error SlippageTooHigh(uint256 minOut, uint256 floor)",
  "error InsufficientOutput(uint256 received, uint256 minOut)",
  "error MarketTokenMismatch(address marketUsd)",
  "error MemoTooLong()",
  "error StrategyTooLong()",
  "error Reentrancy()",
  "error TokenCallFailed(address token)",
  // Errors the market can raise inside a buy, so they decode by name too.
  "error NoPrice(address asset)",
  "error StalePrice(address asset, uint256 updatedAt)",
  "error BelowMinOut(uint256 out, uint256 minOut)",
] as const;

export const vaultAbi = parseAbi([
  "struct Policy { uint128 maxPerTrade; uint128 budgetPerPeriod; uint32 period; uint16 maxSlippageBps; }",
  "function owner() view returns (address)",
  "function usd() view returns (address)",
  "function market() view returns (address)",
  "function agent() view returns (address)",
  "function paused() view returns (bool)",
  "function policy() view returns (uint128 maxPerTrade, uint128 budgetPerPeriod, uint32 period, uint16 maxSlippageBps)",
  "function strategy() view returns (string)",
  "function periodStart() view returns (uint64)",
  "function spentInPeriod() view returns (uint128)",
  "function isAllowed(address asset) view returns (bool)",
  "function assets() view returns (address[])",
  "function remainingBudget() view returns (uint256)",
  "function periodEndsAt() view returns (uint256)",
  "function buy(address asset, uint256 usdIn, uint256 minOut, string memo) returns (uint256)",
  "function deposit(uint256 amount)",
  "function withdraw(address token, uint256 amount, address to)",
  "function setAgent(address agent)",
  "function setMarket(address market)",
  "function setPolicy(Policy policy)",
  "function setAsset(address asset, bool allowed)",
  "function setStrategy(string strategy)",
  "function setPaused(bool paused)",
  "event Bought(address indexed asset, address indexed by, uint256 usdIn, uint256 assetOut, string memo)",
  "event Deposited(address indexed from, uint256 amount)",
  "event Withdrawn(address indexed token, address indexed to, uint256 amount)",
  ...vaultErrors,
]);

export const factoryAbi = parseAbi([
  "struct Policy { uint128 maxPerTrade; uint128 budgetPerPeriod; uint32 period; uint16 maxSlippageBps; }",
  "function usd() view returns (address)",
  "function defaultMarket() view returns (address)",
  "function createVault(address agent, Policy policy, address[] assets, string strategy, uint256 initialDeposit) returns (address)",
  "function vaultsOf(address owner) view returns (address[])",
  "function vaultCount() view returns (uint256)",
  "function vaults(uint256 start, uint256 count) view returns (address[])",
  "event VaultCreated(address indexed owner, address indexed vault, address indexed agent)",
  ...vaultErrors,
]);

export const marketAbi = parseAbi([
  "function usd() view returns (address)",
  "function quoteBuy(address asset, uint256 usdIn) view returns (uint256)",
  "function quotes(address asset) view returns (uint128 price, uint64 updatedAt, uint8 decimals)",
  "function setPrices(address[] assets, uint256[] prices)",
  "function keeper() view returns (address)",
  "function spreadBps() view returns (uint16)",
  "function maxPriceAge() view returns (uint32)",
  "error NoPrice(address asset)",
  "error StalePrice(address asset, uint256 updatedAt)",
  "error NotKeeper()",
]);

export const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
]);
