// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PilotVault} from "../../src/PilotVault.sol";
import {PilotFactory} from "../../src/PilotFactory.sol";
import {OracleMarket} from "../../src/venues/OracleMarket.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";

abstract contract Base is Test {
    uint256 internal constant USD = 1e6; // one dollar of the 6-decimal dollar token

    address internal owner = makeAddr("owner");
    address internal agent = makeAddr("agent");
    address internal keeper = makeAddr("keeper");
    address internal stranger = makeAddr("stranger");

    MockERC20 internal usd;
    MockERC20 internal tsla;
    MockERC20 internal amzn;
    MockERC20 internal nflx; // priced by the market but never allowed in the vault
    OracleMarket internal market;
    PilotFactory internal factory;
    PilotVault internal vault;

    function setUp() public virtual {
        vm.warp(1_760_000_000);
        usd = new MockERC20("Test Dollar", "tUSD", 6);
        tsla = new MockERC20("Tesla (test)", "TSLA", 18);
        amzn = new MockERC20("Amazon (test)", "AMZN", 18);
        nflx = new MockERC20("Netflix (test)", "NFLX", 18);

        market = new OracleMarket(address(usd), keeper, 30, 1 days); // 0.30% spread
        address[] memory priced = new address[](3);
        priced[0] = address(tsla);
        priced[1] = address(amzn);
        priced[2] = address(nflx);
        uint256[] memory prices = new uint256[](3);
        prices[0] = 250e8; // $250.00
        prices[1] = 180e8;
        prices[2] = 600e8;
        vm.prank(keeper);
        market.setPrices(priced, prices);
        tsla.mint(address(market), 1_000_000e18);
        amzn.mint(address(market), 1_000_000e18);
        nflx.mint(address(market), 1_000_000e18);

        factory = new PilotFactory(address(usd), address(market));

        usd.mint(owner, 10_000 * USD);
        vm.startPrank(owner);
        usd.approve(address(factory), 1_000 * USD);
        vault =
            factory.createVault(agent, defaultPolicy(), allowed(), "Buy TSLA and AMZN weekly.", 1_000 * USD);
        vm.stopPrank();
    }

    function defaultPolicy() internal pure returns (PilotVault.Policy memory) {
        return PilotVault.Policy({
            maxPerTrade: uint128(50 * USD),
            budgetPerPeriod: uint128(100 * USD),
            period: 7 days,
            maxSlippageBps: 100 // 1%
        });
    }

    function allowed() internal view returns (address[] memory a) {
        a = new address[](2);
        a[0] = address(tsla);
        a[1] = address(amzn);
    }

    /// @dev What an honest agent passes: the quote less the full allowed slippage.
    function minOutFor(address asset, uint256 usdIn) internal view returns (uint256) {
        return market.quoteBuy(asset, usdIn) * (10_000 - 100) / 10_000;
    }

    function agentBuy(address asset, uint256 usdIn) internal returns (uint256) {
        uint256 minOut = minOutFor(asset, usdIn);
        vm.prank(agent);
        return vault.buy(asset, usdIn, minOut, "test");
    }
}
