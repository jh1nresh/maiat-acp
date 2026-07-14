// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {MaiatEvaluator} from "../contracts/MaiatEvaluator.sol";
import {MaiatHook} from "../contracts/MaiatHook.sol";
import {MaiatOracle} from "../contracts/MaiatOracle.sol";

/**
 * @title DeployEvaluator
 * @notice Deployment script for MaiatEvaluator and MaiatHook on Base Sepolia
 *
 * @dev Usage:
 *   forge script script/DeployEvaluator.s.sol:DeployEvaluator \
 *     --rpc-url $BASE_SEPOLIA_RPC \
 *     --private-key $PRIVATE_KEY \
 *     --broadcast \
 *     --verify
 *
 * Required environment variables:
 *   - ORACLE_ADDRESS: Deployed MaiatOracle address
 *   - ACP_ADDRESS: ERC-8183 ACP contract address
 *   - OPERATOR_ADDRESS: Maiat operator wallet
 *   - EVALUATION_SCHEMA: EAS schema UID for evaluation receipts
 *
 * Optional environment variables:
 *   - DEFAULT_MIN_TRUST_SCORE: Default minimum trust score (default: 50)
 */
contract DeployEvaluator is Script {
    // Base Sepolia EAS address
    address constant EAS_BASE_SEPOLIA = 0x4200000000000000000000000000000000000021;

    // Default configuration
    uint8 constant DEFAULT_MIN_TRUST_SCORE = 50;

    function run() public {
        // Read required environment variables
        address oracleAddress = vm.envAddress("ORACLE_ADDRESS");
        address acpAddress = vm.envAddress("ACP_ADDRESS");
        address operatorAddress = vm.envAddress("OPERATOR_ADDRESS");
        bytes32 evaluationSchema = vm.envBytes32("EVALUATION_SCHEMA");

        // Read optional environment variables with defaults
        uint8 defaultMinTrust = uint8(vm.envOr("DEFAULT_MIN_TRUST_SCORE", uint256(DEFAULT_MIN_TRUST_SCORE)));

        console.log("=== Deployment Configuration ===");
        console.log("Oracle:", oracleAddress);
        console.log("ACP:", acpAddress);
        console.log("EAS:", EAS_BASE_SEPOLIA);
        console.log("Operator:", operatorAddress);
        console.log("Evaluation Schema:", vm.toString(evaluationSchema));
        console.log("Default Min Trust Score:", defaultMinTrust);
        console.log("");

        vm.startBroadcast();

        // Deploy MaiatEvaluator
        MaiatEvaluator evaluator = new MaiatEvaluator(
            oracleAddress, EAS_BASE_SEPOLIA, acpAddress, evaluationSchema, operatorAddress, defaultMinTrust
        );

        console.log("=== Deployed Contracts ===");
        console.log("MaiatEvaluator:", address(evaluator));

        // Deploy MaiatHook
        MaiatHook hook = new MaiatHook(acpAddress, oracleAddress, defaultMinTrust);

        console.log("MaiatHook:", address(hook));

        vm.stopBroadcast();

        // Log verification commands
        console.log("");
        console.log("=== Verification Commands ===");
        console.log("Run these commands to verify on Basescan:");
        console.log("");
        console.log("forge verify-contract", address(evaluator), "contracts/MaiatEvaluator.sol:MaiatEvaluator");
        console.log("forge verify-contract", address(hook), "contracts/MaiatHook.sol:MaiatHook");
    }
}

/**
 * @title DeployEvaluatorWithOracle
 * @notice Deployment script that also deploys a new MaiatOracle
 *
 * @dev Use this when deploying to a fresh environment where no oracle exists.
 *
 * Required environment variables:
 *   - ACP_ADDRESS: ERC-8183 ACP contract address
 *   - OPERATOR_ADDRESS: Maiat operator wallet
 *   - EVALUATION_SCHEMA: EAS schema UID for evaluation receipts
 */
contract DeployEvaluatorWithOracle is Script {
    // Base Sepolia EAS address
    address constant EAS_BASE_SEPOLIA = 0x4200000000000000000000000000000000000021;

    // Default configuration
    uint8 constant DEFAULT_MIN_TRUST_SCORE = 50;

    function run() public {
        // Read required environment variables
        address acpAddress = vm.envAddress("ACP_ADDRESS");
        address operatorAddress = vm.envAddress("OPERATOR_ADDRESS");
        bytes32 evaluationSchema = vm.envBytes32("EVALUATION_SCHEMA");

        // Read optional environment variables with defaults
        uint8 defaultMinTrust = uint8(vm.envOr("DEFAULT_MIN_TRUST_SCORE", uint256(DEFAULT_MIN_TRUST_SCORE)));

        console.log("=== Deployment Configuration ===");
        console.log("ACP:", acpAddress);
        console.log("EAS:", EAS_BASE_SEPOLIA);
        console.log("Operator:", operatorAddress);
        console.log("Evaluation Schema:", vm.toString(evaluationSchema));
        console.log("Default Min Trust Score:", defaultMinTrust);
        console.log("");

        vm.startBroadcast();

        // Deploy MaiatOracle first
        MaiatOracle oracle = new MaiatOracle(operatorAddress);
        console.log("=== Deployed Contracts ===");
        console.log("MaiatOracle:", address(oracle));

        // Deploy MaiatEvaluator
        MaiatEvaluator evaluator = new MaiatEvaluator(
            address(oracle), EAS_BASE_SEPOLIA, acpAddress, evaluationSchema, operatorAddress, defaultMinTrust
        );
        console.log("MaiatEvaluator:", address(evaluator));

        // Deploy MaiatHook
        MaiatHook hook = new MaiatHook(acpAddress, address(oracle), defaultMinTrust);
        console.log("MaiatHook:", address(hook));

        vm.stopBroadcast();

        // Log verification commands
        console.log("");
        console.log("=== Verification Commands ===");
        console.log("Run these commands to verify on Basescan:");
        console.log("");
        console.log("forge verify-contract", address(oracle), "contracts/MaiatOracle.sol:MaiatOracle");
        console.log("forge verify-contract", address(evaluator), "contracts/MaiatEvaluator.sol:MaiatEvaluator");
        console.log("forge verify-contract", address(hook), "contracts/MaiatHook.sol:MaiatHook");
    }
}
