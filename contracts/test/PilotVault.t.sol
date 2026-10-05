// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./utils/Base.sol";
import {PilotVault} from "../src/PilotVault.sol";
import {OracleMarket} from "../src/venues/OracleMarket.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {SafeTransfer} from "../src/libraries/SafeTransfer.sol";
import {ShortchangingMarket, GreedyMarket, ReentrantMarket} from "./utils/HostileMarkets.sol";

contract PilotVaultTest is Base {
    // ------------------------------------------------------------ setup via factory

    function test_factoryCreatesConfiguredFundedVault() public view {
        assertEq(vault.owner(), owner);
        assertEq(vault.agent(), agent);
        assertEq(vault.usd(), address(usd));
        assertEq(vault.market(), address(market));
        assertEq(usd.balanceOf(address(vault)), 1_000 * USD);
        assertTrue(vault.isAllowed(address(tsla)));
        assertTrue(vault.isAllowed(address(amzn)));
        assertFalse(vault.isAllowed(address(nflx)));
        assertEq(vault.strategy(), "Buy TSLA and AMZN weekly.");
        assertEq(vault.remainingBudget(), 100 * USD);
        address[] memory mine = factory.vaultsOf(owner);
        assertEq(mine.length, 1);
        assertEq(mine[0], address(vault));
        assertEq(factory.vaultCount(), 1);
        assertEq(factory.vaults(0, 10)[0], address(vault));
        assertEq(factory.vaults(5, 10).length, 0);
    }

    // ------------------------------------------------------------ happy path

    function test_agentBuysWithinLimits() public {
        uint256 quote = market.quoteBuy(address(tsla), 40 * USD);
        // $40 at $250 = 0.16 TSLA, minus the 0.30% spread
        assertEq(quote, 0.16e18 * 9970 / 10_000);

        vm.expectEmit(true, true, false, true, address(vault));
        emit PilotVault.Bought(address(tsla), agent, 40 * USD, quote, "test");
        uint256 got = agentBuy(address(tsla), 40 * USD);

        assertEq(got, quote);
        assertEq(tsla.balanceOf(address(vault)), quote);
        assertEq(usd.balanceOf(address(vault)), 960 * USD);
        assertEq(vault.spentInPeriod(), 40 * USD);
        assertEq(vault.remainingBudget(), 60 * USD);
        assertEq(usd.allowance(address(vault), address(market)), 0, "approval left behind");
        assertEq(tsla.balanceOf(agent), 0);
        assertEq(usd.balanceOf(agent), 0);
    }

    function test_ownerCanBuyManuallyUnderTheSameRules() public {
        uint256 minOut = minOutFor(address(amzn), 50 * USD);
        vm.prank(owner);
        vault.buy(address(amzn), 50 * USD, minOut, "manual");
        assertGt(amzn.balanceOf(address(vault)), 0);

        minOut = minOutFor(address(amzn), 51 * USD);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PilotVault.OverTradeLimit.selector, 51 * USD, 50 * USD));
        vault.buy(address(amzn), 51 * USD, minOut, "manual");
    }

    // ------------------------------------------------------------ who may buy

    function test_strangerCannotBuy() public {
        vm.prank(stranger);
        vm.expectRevert(PilotVault.NotAgent.selector);
        vault.buy(address(tsla), 10 * USD, 1, "");
    }

    function test_revokedAgentCannotBuy() public {
        vm.prank(owner);
        vault.setAgent(address(0));
        vm.prank(agent);
        vm.expectRevert(PilotVault.NotAgent.selector);
        vault.buy(address(tsla), 10 * USD, 1, "");
    }

    function test_pausedVaultRefusesBuys() public {
        vm.prank(owner);
        vault.setPaused(true);
        vm.prank(agent);
        vm.expectRevert(PilotVault.IsPaused.selector);
        vault.buy(address(tsla), 10 * USD, 1, "");

        vm.prank(owner);
        vault.setPaused(false);
        agentBuy(address(tsla), 10 * USD);
    }

    // ------------------------------------------------------------ what may be bought

    function test_disallowedAssetIsRefused() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PilotVault.AssetNotAllowed.selector, address(nflx)));
        vault.buy(address(nflx), 10 * USD, 1, "");
    }

    function test_removedAssetIsRefused() public {
        vm.prank(owner);
        vault.setAsset(address(tsla), false);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PilotVault.AssetNotAllowed.selector, address(tsla)));
        vault.buy(address(tsla), 10 * USD, 1, "");
        assertEq(vault.assets().length, 2, "list keeps history; isAllowed is the truth");
    }

    function test_cannotAllowTheDollarTokenOrAnEOA() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(PilotVault.InvalidAsset.selector, address(usd)));
        vault.setAsset(address(usd), true);
        vm.expectRevert(abi.encodeWithSelector(PilotVault.InvalidAsset.selector, stranger));
        vault.setAsset(stranger, true);
        vm.stopPrank();
    }

    function test_reallowingDoesNotDuplicate() public {
        vm.startPrank(owner);
        vault.setAsset(address(tsla), false);
        vault.setAsset(address(tsla), true);
        vault.setAsset(address(nflx), true);
        vm.stopPrank();
        assertEq(vault.assets().length, 3);
    }

    // ------------------------------------------------------------ how much

    function test_overTradeLimitIsRefused() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PilotVault.OverTradeLimit.selector, 51 * USD, 50 * USD));
        vault.buy(address(tsla), 51 * USD, 1, "");
    }

    function test_budgetIsEnforcedAcrossTradesAndRefillsNextPeriod() public {
        agentBuy(address(tsla), 50 * USD);
        agentBuy(address(amzn), 40 * USD);
        assertEq(vault.remainingBudget(), 10 * USD);

        uint256 minOut = minOutFor(address(tsla), 11 * USD);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PilotVault.OverBudget.selector, 11 * USD, 10 * USD));
        vault.buy(address(tsla), 11 * USD, minOut, "");

        agentBuy(address(tsla), 10 * USD);
        assertEq(vault.remainingBudget(), 0);

        uint256 ends = vault.periodEndsAt();
        vm.warp(ends - 1);
        assertEq(vault.remainingBudget(), 0);
        vm.warp(ends);
        assertEq(vault.remainingBudget(), 100 * USD);
        _refreshPrices();
        agentBuy(address(tsla), 50 * USD);
        assertEq(vault.remainingBudget(), 50 * USD);
        assertEq(vault.periodEndsAt(), ends + 7 days);
    }

    function test_loweringBudgetBelowSpentLeavesNothing() public {
        agentBuy(address(tsla), 50 * USD);
        PilotVault.Policy memory p = defaultPolicy();
        p.budgetPerPeriod = uint128(20 * USD);
        p.maxPerTrade = uint128(20 * USD);
        vm.prank(owner);
        vault.setPolicy(p);
        assertEq(vault.remainingBudget(), 0);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PilotVault.OverBudget.selector, 1 * USD, 0));
        vault.buy(address(tsla), 1 * USD, 1, "");
    }

    function test_cannotSpendMoreThanTheVaultHolds() public {
        vm.prank(owner);
        vault.withdraw(address(usd), 990 * USD, owner);
        uint256 minOut = minOutFor(address(tsla), 20 * USD);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SafeTransfer.TokenCallFailed.selector, address(usd)));
        vault.buy(address(tsla), 20 * USD, minOut, "");
        assertEq(vault.spentInPeriod(), 0, "a failed buy spends no budget");
    }

    function test_zeroAmountIsRefused() public {
        vm.prank(agent);
        vm.expectRevert(PilotVault.ZeroAmount.selector);
        vault.buy(address(tsla), 0, 1, "");
    }

    // ------------------------------------------------------------ at what price

    function test_minOutBelowSlippageFloorIsRefused() public {
        uint256 quote = market.quoteBuy(address(tsla), 40 * USD);
        uint256 floor = quote * 9900 / 10_000;
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PilotVault.SlippageTooHigh.selector, floor - 1, floor));
        vault.buy(address(tsla), 40 * USD, floor - 1, "");
    }

    function test_minOutOfZeroIsRefused() public {
        uint256 floor = market.quoteBuy(address(tsla), 1 * USD) * 9900 / 10_000;
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PilotVault.SlippageTooHigh.selector, 0, floor));
        vault.buy(address(tsla), 1 * USD, 0, "");
    }

    function test_stalePriceStopsTheAgent() public {
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(agent);
        vm.expectPartialRevert(OracleMarket.StalePrice.selector);
        vault.buy(address(tsla), 10 * USD, 1, "");
    }

    function test_marketWithDifferentDollarIsRefused() public {
        MockERC20 other = new MockERC20("Other", "OTH", 6);
        OracleMarket wrong = new OracleMarket(address(other), keeper, 30, 1 days);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PilotVault.MarketTokenMismatch.selector, address(other)));
        vault.setMarket(address(wrong));
    }

    // ------------------------------------------------------------ hostile markets

    function test_shortchangingMarketIsCaught() public {
        ShortchangingMarket bad = new ShortchangingMarket(address(usd));
        vm.prank(owner);
        vault.setMarket(address(bad));
        uint256 minOut = 10 * USD * 1e12;
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PilotVault.InsufficientOutput.selector, minOut / 2, minOut));
        vault.buy(address(tsla), 10 * USD, minOut, "");
        assertEq(usd.balanceOf(address(vault)), 1_000 * USD);
    }

    function test_greedyMarketCannotPullMoreThanApproved() public {
        GreedyMarket bad = new GreedyMarket(address(usd));
        vm.prank(owner);
        vault.setMarket(address(bad));
        vm.prank(agent);
        vm.expectRevert(); // MockERC20 underflows on the allowance
        vault.buy(address(tsla), 10 * USD, 10 * USD * 1e12, "");
        assertEq(usd.balanceOf(address(vault)), 1_000 * USD);
    }

    function test_reentrantMarketIsBlocked() public {
        ReentrantMarket bad = new ReentrantMarket(address(usd));
        bad.setVault(vault);
        vm.startPrank(owner);
        vault.setMarket(address(bad));
        vault.setAgent(address(bad)); // worst case: the market is also the agent
        vm.stopPrank();
        vm.prank(address(bad));
        vm.expectRevert(PilotVault.Reentrancy.selector);
        vault.buy(address(tsla), 10 * USD, 10 * USD * 1e12, "");
    }

    // ------------------------------------------------------------ owner powers

    function test_onlyOwnerCanWithdrawAndConfigure() public {
        address[2] memory notOwners = [agent, stranger];
        for (uint256 i; i < 2; ++i) {
            vm.startPrank(notOwners[i]);
            vm.expectRevert(PilotVault.NotOwner.selector);
            vault.withdraw(address(usd), 1, notOwners[i]);
            vm.expectRevert(PilotVault.NotOwner.selector);
            vault.setAgent(notOwners[i]);
            vm.expectRevert(PilotVault.NotOwner.selector);
            vault.setPolicy(defaultPolicy());
            vm.expectRevert(PilotVault.NotOwner.selector);
            vault.setAsset(address(nflx), true);
            vm.expectRevert(PilotVault.NotOwner.selector);
            vault.setMarket(address(market));
            vm.expectRevert(PilotVault.NotOwner.selector);
            vault.setStrategy("send everything to me");
            vm.expectRevert(PilotVault.NotOwner.selector);
            vault.setPaused(true);
            vm.stopPrank();
        }
    }

    function test_ownerWithdrawsStocksAndDollars() public {
        uint256 got = agentBuy(address(tsla), 50 * USD);
        vm.startPrank(owner);
        vault.withdraw(address(tsla), got, owner);
        vault.withdraw(address(usd), 950 * USD, owner);
        vm.stopPrank();
        assertEq(tsla.balanceOf(owner), got);
        assertEq(usd.balanceOf(owner), 9_000 * USD + 950 * USD);
        assertEq(usd.balanceOf(address(vault)), 0);
    }

    function test_policyValidation() public {
        PilotVault.Policy memory p = defaultPolicy();
        vm.startPrank(owner);

        p.period = 0;
        vm.expectRevert(PilotVault.InvalidPolicy.selector);
        vault.setPolicy(p);

        p = defaultPolicy();
        p.maxPerTrade = 0;
        vm.expectRevert(PilotVault.InvalidPolicy.selector);
        vault.setPolicy(p);

        p = defaultPolicy();
        p.maxPerTrade = p.budgetPerPeriod + 1;
        vm.expectRevert(PilotVault.InvalidPolicy.selector);
        vault.setPolicy(p);

        p = defaultPolicy();
        p.maxSlippageBps = 1001;
        vm.expectRevert(PilotVault.InvalidPolicy.selector);
        vault.setPolicy(p);

        vm.stopPrank();
    }

    function test_memoAndStrategyLengthLimits() public {
        bytes memory longMemo = new bytes(281);
        uint256 minOut = minOutFor(address(tsla), 10 * USD);
        vm.prank(agent);
        vm.expectRevert(PilotVault.MemoTooLong.selector);
        vault.buy(address(tsla), 10 * USD, minOut, string(longMemo));

        vm.prank(owner);
        vm.expectRevert(PilotVault.StrategyTooLong.selector);
        vault.setStrategy(string(new bytes(2001)));
    }

    function test_anyoneCanDeposit() public {
        usd.mint(stranger, 5 * USD);
        vm.startPrank(stranger);
        usd.approve(address(vault), 5 * USD);
        vault.deposit(5 * USD);
        vm.stopPrank();
        assertEq(usd.balanceOf(address(vault)), 1_005 * USD);
    }

    // ------------------------------------------------------------ fuzz

    /// Whatever the agent asks for, a buy either fails cleanly or stays inside every rule.
    function testFuzz_buyNeverBreaksTheRules(uint256 usdIn, uint256 slipBps, bool useTsla) public {
        usdIn = bound(usdIn, 0, 200 * USD);
        slipBps = bound(slipBps, 0, 300);
        address asset = useTsla ? address(tsla) : address(amzn);
        uint256 quote = usdIn == 0 ? 0 : market.quoteBuy(asset, usdIn);
        uint256 minOut = quote * (10_000 - slipBps) / 10_000;
        uint256 vaultUsdBefore = usd.balanceOf(address(vault));

        vm.prank(agent);
        try vault.buy(asset, usdIn, minOut, "fuzz") returns (uint256 got) {
            assertLe(usdIn, 50 * USD, "per-trade limit");
            assertGe(minOut, quote * 9900 / 10_000, "slippage bound");
            assertGe(got, minOut);
            assertEq(usd.balanceOf(address(vault)), vaultUsdBefore - usdIn);
        } catch {
            assertEq(usd.balanceOf(address(vault)), vaultUsdBefore);
            assertEq(vault.spentInPeriod(), 0);
        }
    }

    function _refreshPrices() internal {
        address[] memory a = new address[](2);
        a[0] = address(tsla);
        a[1] = address(amzn);
        uint256[] memory p = new uint256[](2);
        p[0] = 250e8;
        p[1] = 180e8;
        vm.prank(keeper);
        market.setPrices(a, p);
    }
}
