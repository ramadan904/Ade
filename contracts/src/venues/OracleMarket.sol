// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20Metadata} from "../interfaces/IERC20.sol";
import {IMarket} from "../interfaces/IMarket.sol";
import {SafeTransfer} from "../libraries/SafeTransfer.sol";

/// @title OracleMarket
/// @notice A simple market maker for testnets and demos: it sells stock tokens from its own inventory at
///         a posted price plus a spread, and refuses to trade on a price older than `maxPriceAge`.
/// @dev Prices are dollars per whole token with 8 decimals (Chainlink's convention). A keeper posts
///      them. On mainnet, vaults point at an adapter for a real venue instead; IMarket is the seam.
contract OracleMarket is IMarket {
    using SafeTransfer for address;

    uint256 public constant PRICE_DECIMALS = 8;

    address public immutable usd;
    uint8 public immutable usdDecimals;

    address public owner;
    address public keeper;
    uint16 public spreadBps;
    uint32 public maxPriceAge;

    struct Quote {
        uint128 price; // dollars per whole token, 8 decimals
        uint64 updatedAt;
        uint8 decimals; // the asset's own decimals
    }

    mapping(address asset => Quote) public quotes;

    event PriceSet(address indexed asset, uint256 price);
    event Sold(
        address indexed asset, address indexed buyer, address indexed to, uint256 usdIn, uint256 assetOut
    );
    event ConfigSet(address keeper, uint16 spreadBps, uint32 maxPriceAge);
    event OwnerSet(address owner);

    error NotOwner();
    error NotKeeper();
    error NoPrice(address asset);
    error StalePrice(address asset, uint256 updatedAt);
    error BelowMinOut(uint256 out, uint256 minOut);
    error InvalidConfig();
    error LengthMismatch();

    constructor(address usd_, address keeper_, uint16 spreadBps_, uint32 maxPriceAge_) {
        usd = usd_;
        usdDecimals = IERC20Metadata(usd_).decimals();
        owner = msg.sender;
        emit OwnerSet(msg.sender);
        _setConfig(keeper_, spreadBps_, maxPriceAge_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function quoteBuy(address asset, uint256 usdIn) public view returns (uint256) {
        Quote memory q = quotes[asset];
        if (q.price == 0) revert NoPrice(asset);
        if (block.timestamp > uint256(q.updatedAt) + maxPriceAge) revert StalePrice(asset, q.updatedAt);
        // out = usdIn / price, scaled from usd decimals to asset decimals, minus the spread.
        uint256 gross = usdIn * 10 ** (q.decimals + PRICE_DECIMALS) / (uint256(q.price) * 10 ** usdDecimals);
        return gross * (10_000 - spreadBps) / 10_000;
    }

    function buy(address asset, uint256 usdIn, uint256 minOut, address to) external returns (uint256 out) {
        out = quoteBuy(asset, usdIn);
        if (out < minOut || out == 0) revert BelowMinOut(out, minOut);
        usd.safeTransferFrom(msg.sender, address(this), usdIn);
        asset.safeTransfer(to, out);
        emit Sold(asset, msg.sender, to, usdIn, out);
    }

    function setPrices(address[] calldata assets, uint256[] calldata prices) external {
        if (msg.sender != keeper && msg.sender != owner) revert NotKeeper();
        if (assets.length != prices.length) revert LengthMismatch();
        for (uint256 i; i < assets.length; ++i) {
            if (prices[i] == 0 || prices[i] > type(uint128).max) revert InvalidConfig();
            quotes[assets[i]] = Quote({
                price: uint128(prices[i]),
                updatedAt: uint64(block.timestamp),
                decimals: IERC20Metadata(assets[i]).decimals()
            });
            emit PriceSet(assets[i], prices[i]);
        }
    }

    function setConfig(address keeper_, uint16 spreadBps_, uint32 maxPriceAge_) external onlyOwner {
        _setConfig(keeper_, spreadBps_, maxPriceAge_);
    }

    function setOwner(address owner_) external onlyOwner {
        owner = owner_;
        emit OwnerSet(owner_);
    }

    /// @notice Take inventory or collected dollars out.
    function withdraw(address token, uint256 amount, address to) external onlyOwner {
        token.safeTransfer(to, amount);
    }

    function _setConfig(address keeper_, uint16 spreadBps_, uint32 maxPriceAge_) private {
        if (spreadBps_ > 1000 || maxPriceAge_ == 0) revert InvalidConfig();
        keeper = keeper_;
        spreadBps = spreadBps_;
        maxPriceAge = maxPriceAge_;
        emit ConfigSet(keeper_, spreadBps_, maxPriceAge_);
    }
}
