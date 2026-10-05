// Everything the web app needs from viem and the agent, bundled into web/vendor/lib.js by `npm run build:web`.
export {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseEventLogs,
  parseUnits,
} from "viem";
export { privateKeyToAccount } from "viem/accounts";
export { erc20Abi, factoryAbi, marketAbi, vaultAbi } from "./abi.js";
