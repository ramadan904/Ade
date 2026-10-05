// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PilotFactory} from "../src/PilotFactory.sol";
import {OracleMarket} from "../src/venues/OracleMarket.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {IERC20Metadata} from "../src/interfaces/IERC20.sol";

/// @notice Deploys the market and the factory, and writes deployments/<chainId>.json.
///
/// Environment (all optional):
///   USD_TOKEN       dollar token to use; empty deploys a 6-decimal test dollar (tUSD) with an open mint
///   STOCK_TOKENS    comma-separated stock token addresses (e.g. Robinhood Chain testnet's TSLA, AMZN, ...);
///                   empty deploys test stock tokens and mints the market an inventory
///   STOCK_PRICES    comma-separated prices in dollars with 8 decimals, same order as the stocks
///   KEEPER          address allowed to post prices (default: the deployer)
///   SPREAD_BPS      market spread (default 30 = 0.30%)
///   MAX_PRICE_AGE   seconds before a price is stale (default 86400)
contract Deploy is Script {
    string[5] internal SYMBOLS = ["TSLA", "AMZN", "PLTR", "NFLX", "AMD"];
    string[5] internal NAMES = ["Tesla", "Amazon", "Palantir", "Netflix", "AMD"];
    uint256[5] internal DEMO_PRICES = [uint256(250e8), 180e8, 30e8, 600e8, 140e8];

    function run() external {
        address deployer = msg.sender;
        address keeper = vm.envOr("KEEPER", deployer);
        uint16 spread = uint16(vm.envOr("SPREAD_BPS", uint256(30)));
        uint32 maxAge = uint32(vm.envOr("MAX_PRICE_AGE", uint256(1 days)));
        address usd = vm.envOr("USD_TOKEN", address(0));
        address[] memory stocks = vm.envOr("STOCK_TOKENS", ",", new address[](0));
        uint256[] memory prices = vm.envOr("STOCK_PRICES", ",", new uint256[](0));
        bool mockStocks = stocks.length == 0;

        vm.startBroadcast();

        if (usd == address(0)) usd = address(new MockERC20("Test Dollar", "tUSD", 6));

        if (mockStocks) {
            stocks = new address[](SYMBOLS.length);
            prices = new uint256[](SYMBOLS.length);
            for (uint256 i; i < SYMBOLS.length; ++i) {
                stocks[i] = address(new MockERC20(string.concat(NAMES[i], " (test)"), SYMBOLS[i], 18));
                prices[i] = DEMO_PRICES[i];
            }
        }
        require(prices.length == stocks.length, "STOCK_PRICES must match STOCK_TOKENS");

        // The deployer posts the first prices, then hands price updates to the keeper.
        OracleMarket market = new OracleMarket(usd, deployer, spread, maxAge);
        market.setPrices(stocks, prices);
        if (keeper != deployer) market.setConfig(keeper, spread, maxAge);
        if (mockStocks) {
            for (uint256 i; i < stocks.length; ++i) {
                MockERC20(stocks[i]).mint(address(market), 1_000_000e18);
            }
        }

        PilotFactory factory = new PilotFactory(usd, address(market));

        vm.stopBroadcast();

        _write(usd, address(market), address(factory), keeper, stocks, mockStocks);
    }

    function _write(address usd, address market, address factory, address keeper, address[] memory stocks, bool mock)
        internal
    {
        string memory tokens = "tokens";
        string memory list;
        for (uint256 i; i < stocks.length; ++i) {
            list = vm.serializeAddress(tokens, IERC20Metadata(stocks[i]).symbol(), stocks[i]);
        }
        string memory root = "root";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeUint(root, "deployedAtBlock", block.number);
        vm.serializeAddress(root, "usd", usd);
        vm.serializeString(root, "usdSymbol", IERC20Metadata(usd).symbol());
        vm.serializeAddress(root, "market", market);
        vm.serializeAddress(root, "factory", factory);
        vm.serializeAddress(root, "keeper", keeper);
        vm.serializeBool(root, "testTokens", mock);
        string memory json = vm.serializeString(root, "stocks", list);

        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console.log("factory", factory);
        console.log("market ", market);
        console.log("usd    ", usd);
        console.log("wrote  ", path);
    }
}
