// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IMarket} from "../../src/interfaces/IMarket.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";
import {PilotVault} from "../../src/PilotVault.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";

/// @dev Quotes generously, then delivers half while claiming full delivery.
contract ShortchangingMarket is IMarket {
    address public immutable usd;

    constructor(address usd_) {
        usd = usd_;
    }

    function quoteBuy(address, uint256 usdIn) public pure returns (uint256) {
        return usdIn * 1e12;
    }

    function buy(address asset, uint256 usdIn, uint256, address to) external returns (uint256) {
        IERC20(usd).transferFrom(msg.sender, address(this), usdIn);
        MockERC20(asset).mint(to, quoteBuy(asset, usdIn) / 2);
        return quoteBuy(asset, usdIn);
    }
}

/// @dev Tries to pull more dollars than the vault approved.
contract GreedyMarket is IMarket {
    address public immutable usd;

    constructor(address usd_) {
        usd = usd_;
    }

    function quoteBuy(address, uint256 usdIn) public pure returns (uint256) {
        return usdIn * 1e12;
    }

    function buy(address asset, uint256 usdIn, uint256, address to) external returns (uint256) {
        IERC20(usd).transferFrom(msg.sender, address(this), usdIn * 2);
        MockERC20(asset).mint(to, quoteBuy(asset, usdIn));
        return quoteBuy(asset, usdIn);
    }
}

/// @dev Re-enters the vault during the buy, as the agent would.
contract ReentrantMarket is IMarket {
    address public immutable usd;
    PilotVault public vault;

    constructor(address usd_) {
        usd = usd_;
    }

    function setVault(PilotVault v) external {
        vault = v;
    }

    function quoteBuy(address, uint256 usdIn) public pure returns (uint256) {
        return usdIn * 1e12;
    }

    function buy(address asset, uint256 usdIn, uint256 minOut, address to) external returns (uint256) {
        IERC20(usd).transferFrom(msg.sender, address(this), usdIn);
        vault.buy(asset, usdIn, minOut, "again");
        MockERC20(asset).mint(to, quoteBuy(asset, usdIn));
        return quoteBuy(asset, usdIn);
    }
}
