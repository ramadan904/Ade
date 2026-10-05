// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice A venue the vault buys stock tokens from, paying in its dollar token.
/// @dev Adapters for real venues (an AMM, an RFQ desk) implement this. The vault never trusts the
///      venue's word for what it delivered: it checks its own balance before and after.
interface IMarket {
    /// @notice The dollar token this market is paid in.
    function usd() external view returns (address);

    /// @notice How much `asset` `usdIn` dollars buys right now. Reverts when there is no usable price.
    function quoteBuy(address asset, uint256 usdIn) external view returns (uint256 assetOut);

    /// @notice Pulls `usdIn` dollars from the caller and sends at least `minOut` of `asset` to `to`.
    function buy(address asset, uint256 usdIn, uint256 minOut, address to) external returns (uint256 assetOut);
}
