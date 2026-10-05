// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Base} from "./utils/Base.sol";
import {PilotVault} from "../src/PilotVault.sol";
import {OracleMarket} from "../src/venues/OracleMarket.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

/// @dev Drives the vault the way a confused or malicious agent might: random assets, amounts,
///      slippage and timing, plus random owner pauses and price moves.
contract Handler is Test {
    PilotVault public vault;
    OracleMarket public market;
    MockERC20 public usd;
    address public agent;
    address public owner;
    address public keeper;
    address[] public candidates;

    uint256 public totalSpent; // ghost: dollars that left the vault through buys
    uint256 public buys;
    uint256 public maxSpentInAnyPeriod;
    uint256 internal currentPeriodStart;
    uint256 internal spentThisPeriod;

    constructor(
        PilotVault v,
        OracleMarket m,
        MockERC20 u,
        address agent_,
        address owner_,
        address keeper_,
        address[] memory c
    ) {
        vault = v;
        market = m;
        usd = u;
        agent = agent_;
        owner = owner_;
        keeper = keeper_;
        candidates = c;
        currentPeriodStart = v.periodStart();
    }

    function buy(uint256 assetSeed, uint256 usdIn, uint256 slipBps) external {
        address asset = candidates[assetSeed % candidates.length];
        usdIn = bound(usdIn, 1, 120e6);
        slipBps = bound(slipBps, 0, 500);
        uint256 minOut;
        try market.quoteBuy(asset, usdIn) returns (uint256 q) {
            minOut = q * (10_000 - slipBps) / 10_000;
        } catch {
            minOut = 1;
        }
        uint256 before = usd.balanceOf(address(vault));
        vm.prank(agent);
        try vault.buy(asset, usdIn, minOut, "inv") {
            totalSpent += before - usd.balanceOf(address(vault));
            buys++;
            if (vault.periodStart() != currentPeriodStart) {
                currentPeriodStart = vault.periodStart();
                spentThisPeriod = 0;
            }
            spentThisPeriod += usdIn;
            if (spentThisPeriod > maxSpentInAnyPeriod) maxSpentInAnyPeriod = spentThisPeriod;
        } catch {}
    }

    function wait(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 3 days));
    }

    function refreshPrices(uint256 tslaPrice, uint256 amznPrice) external {
        address[] memory a = new address[](2);
        a[0] = candidates[0];
        a[1] = candidates[1];
        uint256[] memory p = new uint256[](2);
        p[0] = bound(tslaPrice, 1e8, 2_000e8);
        p[1] = bound(amznPrice, 1e8, 2_000e8);
        vm.prank(keeper);
        market.setPrices(a, p);
    }

    function togglePause(bool paused) external {
        vm.prank(owner);
        vault.setPaused(paused);
    }
}

contract PilotVaultInvariantTest is Base {
    Handler internal handler;
    uint256 internal initialUsd;

    function setUp() public override {
        super.setUp();
        address[] memory c = new address[](3);
        c[0] = address(tsla);
        c[1] = address(amzn);
        c[2] = address(nflx); // never allowed
        handler = new Handler(vault, market, usd, agent, owner, keeper, c);
        initialUsd = usd.balanceOf(address(vault));
        targetContract(address(handler));
    }

    /// The handler's buy path really trades, so the invariants below are not vacuous.
    function test_handlerBuyGoesThrough() public {
        handler.buy(0, 10 * USD, 50);
        assertEq(handler.buys(), 1);
        assertEq(handler.totalSpent(), 10 * USD);
    }

    /// The budget is never exceeded in any period.
    function invariant_budgetPerPeriodHolds() public view {
        assertLe(handler.maxSpentInAnyPeriod(), 100 * USD);
        assertLe(vault.spentInPeriod(), 100 * USD);
    }

    /// Dollars only leave through buys; nothing else moves them.
    function invariant_dollarsAccountedFor() public view {
        assertEq(usd.balanceOf(address(vault)) + handler.totalSpent(), initialUsd);
    }

    /// The agent never ends up holding anything, and the vault never holds a disallowed asset.
    function invariant_agentGetsNothing() public view {
        assertEq(usd.balanceOf(agent), 0);
        assertEq(tsla.balanceOf(agent), 0);
        assertEq(amzn.balanceOf(agent), 0);
        assertEq(nflx.balanceOf(address(vault)), 0);
    }

    /// No approval to the market survives a buy.
    function invariant_noDanglingApproval() public view {
        assertEq(usd.allowance(address(vault), address(market)), 0);
    }
}
