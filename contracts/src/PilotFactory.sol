// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PilotVault} from "./PilotVault.sol";
import {SafeTransfer} from "./libraries/SafeTransfer.sol";

/// @title PilotFactory
/// @notice Opens a configured, funded PilotVault in one transaction.
contract PilotFactory {
    using SafeTransfer for address;

    address public immutable usd;
    address public immutable defaultMarket;

    mapping(address owner => address[]) private _vaultsOf;
    address[] private _allVaults;

    event VaultCreated(address indexed owner, address indexed vault, address indexed agent);

    constructor(address usd_, address defaultMarket_) {
        usd = usd_;
        defaultMarket = defaultMarket_;
    }

    /// @notice Create a vault owned by the caller. With `initialDeposit` > 0, the caller must have
    ///         approved this factory for that many dollars first.
    function createVault(
        address agent,
        PilotVault.Policy calldata policy,
        address[] calldata assets,
        string calldata strategy,
        uint256 initialDeposit
    ) external returns (PilotVault vault) {
        vault = new PilotVault(msg.sender, usd, defaultMarket, agent, policy, assets, strategy);
        _vaultsOf[msg.sender].push(address(vault));
        _allVaults.push(address(vault));
        if (initialDeposit > 0) usd.safeTransferFrom(msg.sender, address(vault), initialDeposit);
        emit VaultCreated(msg.sender, address(vault), agent);
    }

    function vaultsOf(address owner) external view returns (address[] memory) {
        return _vaultsOf[owner];
    }

    function vaultCount() external view returns (uint256) {
        return _allVaults.length;
    }

    /// @notice A page of all vaults, for agents that serve many owners.
    function vaults(uint256 start, uint256 count) external view returns (address[] memory page) {
        uint256 n = _allVaults.length;
        if (start >= n) return page;
        uint256 end = start + count > n ? n : start + count;
        page = new address[](end - start);
        for (uint256 i = start; i < end; ++i) {
            page[i - start] = _allVaults[i];
        }
    }
}
