// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "./interfaces/IERC20.sol";
import {IMarket} from "./interfaces/IMarket.sol";
import {SafeTransfer} from "./libraries/SafeTransfer.sol";

/// @title PilotVault
/// @notice One person's stock-buying account, run by an AI agent they choose.
///
/// The owner funds the vault with dollars and writes the rules. The agent can do exactly one thing:
/// buy a stock token the owner allowed, with dollars already in the vault, within the owner's limits.
/// Everything it buys stays in the vault. Only the owner can withdraw, change the rules, swap the
/// agent or pause it.
///
/// Rules the contract enforces on every buy, whoever is driving the agent:
///   - the asset is on the owner's allowlist
///   - the amount is at most `maxPerTrade`
///   - total spend in the current period stays within `budgetPerPeriod`
///   - the agent's `minOut` is no worse than the market quote minus `maxSlippageBps`
///   - the vault really received at least `minOut` (balance checked before and after)
contract PilotVault {
    using SafeTransfer for address;

    struct Policy {
        uint128 maxPerTrade; // dollars (in the dollar token's units) per buy
        uint128 budgetPerPeriod; // dollars across all buys in one period
        uint32 period; // seconds, e.g. 7 days
        uint16 maxSlippageBps; // how far below the market quote minOut may be, in basis points
    }

    uint256 public constant MAX_MEMO_BYTES = 280;
    uint256 public constant MAX_STRATEGY_BYTES = 2000;
    uint256 public constant MAX_ASSETS = 32;
    uint16 public constant MAX_SLIPPAGE_CAP_BPS = 1000; // owner cannot allow more than 10%

    address public immutable owner;
    address public immutable usd;

    address public market;
    address public agent;
    bool public paused;
    Policy public policy;
    /// @notice The owner's instructions to the agent, in plain language. The agent reads them from here.
    string public strategy;

    uint64 public periodStart;
    uint128 public spentInPeriod;

    mapping(address asset => bool) public isAllowed;
    address[] private _assets;

    uint256 private _lock = 1;

    event AgentSet(address indexed agent);
    event MarketSet(address indexed market);
    event PolicySet(uint128 maxPerTrade, uint128 budgetPerPeriod, uint32 period, uint16 maxSlippageBps);
    event AssetSet(address indexed asset, bool allowed);
    event StrategySet(string strategy);
    event PausedSet(bool paused);
    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    /// @notice One buy, with the agent's own one-line reason for it.
    event Bought(address indexed asset, address indexed by, uint256 usdIn, uint256 assetOut, string memo);

    error NotOwner();
    error NotAgent();
    error IsPaused();
    error ZeroAddress();
    error ZeroAmount();
    error AssetNotAllowed(address asset);
    error InvalidAsset(address asset);
    error TooManyAssets();
    error InvalidPolicy();
    error OverTradeLimit(uint256 amount, uint256 limit);
    error OverBudget(uint256 amount, uint256 remaining);
    error SlippageTooHigh(uint256 minOut, uint256 floor);
    error InsufficientOutput(uint256 received, uint256 minOut);
    error MarketTokenMismatch(address marketUsd);
    error MemoTooLong();
    error StrategyTooLong();
    error Reentrancy();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(
        address owner_,
        address usd_,
        address market_,
        address agent_,
        Policy memory policy_,
        address[] memory assets_,
        string memory strategy_
    ) {
        if (owner_ == address(0) || usd_ == address(0)) revert ZeroAddress();
        owner = owner_;
        usd = usd_;
        _setMarket(market_);
        agent = agent_;
        emit AgentSet(agent_);
        _setPolicy(policy_);
        for (uint256 i; i < assets_.length; ++i) {
            _setAsset(assets_[i], true);
        }
        _setStrategy(strategy_);
        periodStart = uint64(block.timestamp);
    }

    // ---------------------------------------------------------------- agent

    /// @notice Buy `asset` with `usdIn` of the vault's dollars. Callable by the agent or the owner.
    /// @param minOut The least `asset` the vault accepts; must be within `maxSlippageBps` of the quote.
    /// @param memo A short reason, kept on-chain in the `Bought` event so the owner can audit the agent.
    function buy(address asset, uint256 usdIn, uint256 minOut, string calldata memo)
        external
        nonReentrant
        returns (uint256 received)
    {
        if (msg.sender != agent && msg.sender != owner) revert NotAgent();
        if (paused) revert IsPaused();
        if (!isAllowed[asset]) revert AssetNotAllowed(asset);
        if (usdIn == 0) revert ZeroAmount();
        if (bytes(memo).length > MAX_MEMO_BYTES) revert MemoTooLong();

        Policy memory p = policy;
        if (usdIn > p.maxPerTrade) revert OverTradeLimit(usdIn, p.maxPerTrade);

        _rollPeriod(p.period);
        uint256 remaining = _remaining(p.budgetPerPeriod, spentInPeriod);
        if (usdIn > remaining) revert OverBudget(usdIn, remaining);

        address m = market;
        uint256 floor = IMarket(m).quoteBuy(asset, usdIn) * (10_000 - p.maxSlippageBps) / 10_000;
        if (minOut < floor || minOut == 0) revert SlippageTooHigh(minOut, floor);

        // Effects before the external calls: the budget is spent even if the market re-enters.
        spentInPeriod += uint128(usdIn);

        uint256 before = IERC20(asset).balanceOf(address(this));
        usd.safeApprove(m, usdIn);
        IMarket(m).buy(asset, usdIn, minOut, address(this));
        usd.safeApprove(m, 0);
        received = IERC20(asset).balanceOf(address(this)) - before;
        if (received < minOut) revert InsufficientOutput(received, minOut);

        emit Bought(asset, msg.sender, usdIn, received, memo);
    }

    // ---------------------------------------------------------------- anyone

    /// @notice Add dollars to the vault (needs an approval first). Plain transfers work too.
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usd.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    // ---------------------------------------------------------------- owner

    function withdraw(address token, uint256 amount, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        token.safeTransfer(to, amount);
        emit Withdrawn(token, to, amount);
    }

    /// @notice Set to address(0) to revoke the agent.
    function setAgent(address agent_) external onlyOwner {
        agent = agent_;
        emit AgentSet(agent_);
    }

    function setMarket(address market_) external onlyOwner {
        _setMarket(market_);
    }

    function setPolicy(Policy calldata policy_) external onlyOwner {
        _setPolicy(policy_);
    }

    function setAsset(address asset, bool allowed) external onlyOwner {
        _setAsset(asset, allowed);
    }

    function setStrategy(string calldata strategy_) external onlyOwner {
        _setStrategy(strategy_);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    // ---------------------------------------------------------------- views

    /// @notice Every asset ever allowed; check `isAllowed` for the current state.
    function assets() external view returns (address[] memory) {
        return _assets;
    }

    /// @notice Dollars the agent can still spend in the current period.
    function remainingBudget() external view returns (uint256) {
        Policy memory p = policy;
        if (block.timestamp >= uint256(periodStart) + p.period) return p.budgetPerPeriod;
        return _remaining(p.budgetPerPeriod, spentInPeriod);
    }

    /// @notice When the current budget period ends (and the budget refills on the next buy).
    function periodEndsAt() external view returns (uint256) {
        Policy memory p = policy;
        if (block.timestamp >= uint256(periodStart) + p.period) return block.timestamp;
        return uint256(periodStart) + p.period;
    }

    // ---------------------------------------------------------------- internal

    function _rollPeriod(uint32 period) private {
        if (block.timestamp >= uint256(periodStart) + period) {
            periodStart = uint64(block.timestamp);
            spentInPeriod = 0;
        }
    }

    function _remaining(uint256 budget, uint256 spent) private pure returns (uint256) {
        return budget > spent ? budget - spent : 0;
    }

    function _setMarket(address market_) private {
        if (market_ == address(0)) revert ZeroAddress();
        address marketUsd = IMarket(market_).usd();
        if (marketUsd != usd) revert MarketTokenMismatch(marketUsd);
        market = market_;
        emit MarketSet(market_);
    }

    function _setPolicy(Policy memory p) private {
        if (p.period == 0 || p.maxPerTrade == 0 || p.maxPerTrade > p.budgetPerPeriod) revert InvalidPolicy();
        if (p.maxSlippageBps > MAX_SLIPPAGE_CAP_BPS) revert InvalidPolicy();
        policy = p;
        emit PolicySet(p.maxPerTrade, p.budgetPerPeriod, p.period, p.maxSlippageBps);
    }

    function _setAsset(address asset, bool allowed) private {
        if (asset == address(0) || asset == usd || asset.code.length == 0) revert InvalidAsset(asset);
        if (allowed && !_known(asset)) {
            if (_assets.length >= MAX_ASSETS) revert TooManyAssets();
            _assets.push(asset);
        }
        isAllowed[asset] = allowed;
        emit AssetSet(asset, allowed);
    }

    function _known(address asset) private view returns (bool) {
        for (uint256 i; i < _assets.length; ++i) {
            if (_assets[i] == asset) return true;
        }
        return false;
    }

    function _setStrategy(string memory s) private {
        if (bytes(s).length > MAX_STRATEGY_BYTES) revert StrategyTooLong();
        strategy = s;
        emit StrategySet(s);
    }
}
