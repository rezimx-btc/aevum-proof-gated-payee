// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ProofGatedPayee} from "../src/ProofGatedPayee.sol";

/// @notice Deploys ProofGatedPayee to the Aevum testnet (chain 44005).
/// @dev Dry run (no broadcast):
///      forge script script/Deploy.s.sol --rpc-url aevum
///      Real deploy (needs tQDAY gas + the deployer's key):
///      PRIVATE_KEY=0x... forge script script/Deploy.s.sol --rpc-url aevum --broadcast
///      The token defaults to the verified tUSD8 address on Aevum testnet;
///      override with TUSD8_ADDRESS=0x... if needed.
///      NEVER commit a real private key. Use a throwaway deploy key or a
///      hardware/CI secret — this repo must never contain one.
contract Deploy is Script {
    /// @notice tUSD8 on Aevum testnet (verified 21 Nov 2026: name/symbol
    ///         "tUSD8", decimals 6, bytecode present).
    address internal constant TUSD8_TESTNET = 0x456569838f1d43009A91ebA4263147Afd7233483;

    function run() external {
        address token = vm.envOr("TUSD8_ADDRESS", TUSD8_TESTNET);
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerKey);
        ProofGatedPayee pgp = new ProofGatedPayee(token);
        vm.stopBroadcast();

        console.log("ProofGatedPayee deployed at:", address(pgp));
        console.log("token (tUSD8):", token);
        console.log("owner:", pgp.owner());
        console.log("explorer: https://explorer-test.qday.info/address/%s", address(pgp));
    }
}
