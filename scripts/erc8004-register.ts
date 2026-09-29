#!/usr/bin/env tsx
/**
 * ERC-8004 Identity Registration Script for Maiat Agent
 *
 * Registers Maiat on the ERC-8004 IdentityRegistry (Base Mainnet)
 *
 * Usage: MAIAT_PRIVATE_KEY=0x... npm run erc8004:register
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbiItem,
  decodeEventLog,
  type Hash,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import * as fs from "fs";
import * as path from "path";

// ERC-8004 Contract Addresses (Base Mainnet)
const IDENTITY_REGISTRY_ADDRESS = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const;
const REPUTATION_REGISTRY_ADDRESS = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as const;

// Maiat agent wallet
const MAIAT_AGENT_WALLET = "0xE6ac05D2b50cd525F793024D75BB6f519a52Af5D" as const;

// Agent URI (raw GitHub URL)
const AGENT_URI =
  "https://raw.githubusercontent.com/JhiNResH/maiat-acp/main/scripts/erc8004-agent-registration.json";

// Base RPC
const BASE_RPC = "https://mainnet.base.org";

// ERC-721 Transfer event signature
const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
);

// IdentityRegistry ABI (minimal for register function)
const IDENTITY_REGISTRY_ABI = [
  {
    name: "register",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    name: "setAgentWallet",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "newWallet", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "sig", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

async function main() {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║           ERC-8004 Identity Registration - Maiat           ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  // Step 1: Check for private key
  const privateKey = process.env.MAIAT_PRIVATE_KEY;
  if (!privateKey) {
    console.error("❌ Error: MAIAT_PRIVATE_KEY environment variable is required");
    console.error("   Usage: MAIAT_PRIVATE_KEY=0x... npm run erc8004:register");
    process.exit(1);
  }

  // Validate private key format
  if (!privateKey.startsWith("0x") || privateKey.length !== 66) {
    console.error("❌ Error: MAIAT_PRIVATE_KEY must be a 64-character hex string prefixed with 0x");
    process.exit(1);
  }

  // Step 2: Create account from private key
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  console.log(`📍 Registering from wallet: ${account.address}`);
  console.log(`📍 Target agent wallet: ${MAIAT_AGENT_WALLET}`);
  console.log(`📍 Agent URI: ${AGENT_URI}\n`);

  // Step 3: Create clients
  const publicClient = createPublicClient({
    chain: base,
    transport: http(BASE_RPC),
  });

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(BASE_RPC),
  });

  // Step 4: Check balance
  const balance = await publicClient.getBalance({ address: account.address });
  const balanceInEth = Number(balance) / 1e18;
  console.log(`💰 Wallet balance: ${balanceInEth.toFixed(6)} ETH`);

  if (balance === 0n) {
    console.error("❌ Error: Wallet has no ETH for gas. Please fund the wallet.");
    process.exit(1);
  }

  // Step 5: Call register(agentURI)
  console.log("\n📝 Calling register(agentURI)...");

  let txHash: Hash;
  try {
    txHash = await walletClient.writeContract({
      address: IDENTITY_REGISTRY_ADDRESS,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: "register",
      args: [AGENT_URI],
    });
    console.log(`✅ Transaction submitted: ${txHash}`);
  } catch (error: any) {
    console.error("❌ Error submitting transaction:", error.message || error);
    process.exit(1);
  }

  // Step 6: Wait for transaction receipt
  console.log("⏳ Waiting for confirmation...");
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  if (receipt.status !== "success") {
    console.error("❌ Transaction failed!");
    console.error("Receipt:", JSON.stringify(receipt, null, 2));
    process.exit(1);
  }

  console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}`);

  // Step 7: Parse Transfer event to get agentId (tokenId)
  let agentId: bigint | null = null;

  for (const log of receipt.logs) {
    try {
      // Check if this log is from the IdentityRegistry
      if (log.address.toLowerCase() !== IDENTITY_REGISTRY_ADDRESS.toLowerCase()) {
        continue;
      }

      const decoded = decodeEventLog({
        abi: [TRANSFER_EVENT],
        data: log.data,
        topics: log.topics,
      });

      if (decoded.eventName === "Transfer") {
        agentId = decoded.args.tokenId;
        console.log(`\n🎉 Successfully registered Maiat on ERC-8004!`);
        console.log(`   Agent ID: ${agentId.toString()}`);
        break;
      }
    } catch {
      // Not a Transfer event, skip
      continue;
    }
  }

  if (agentId === null) {
    console.error("❌ Could not parse agentId from transaction logs");
    console.log(
      "Raw logs:",
      JSON.stringify(receipt.logs, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)
    );
    process.exit(1);
  }

  // Step 8: Save result to file
  const result = {
    agentId: agentId.toString(),
    txHash,
    agentURI: AGENT_URI,
    registeredAt: new Date().toISOString(),
    contractAddress: IDENTITY_REGISTRY_ADDRESS,
    chainId: base.id,
    registeredBy: account.address,
    targetWallet: MAIAT_AGENT_WALLET,
  };

  const resultPath = path.join(__dirname, "erc8004-result.json");
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
  console.log(`\n📄 Result saved to: ${resultPath}`);

  // Step 9: Output next steps
  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║                        NEXT STEPS                          ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`
1. Update erc8004-agent-registration.json:
   Add the agentId to the "registrations" array:

   "registrations": [
     {
       "chainId": 8453,
       "registry": "${IDENTITY_REGISTRY_ADDRESS}",
       "agentId": "${agentId.toString()}"
     }
   ]

2. Set agent wallet (if needed):
   Call setAgentWallet(${agentId}, "${MAIAT_AGENT_WALLET}", nonce, signature)
   to configure the receiving wallet for payments.

3. Add to environment variables:
   export ERC8004_AGENT_ID=${agentId}

4. View on BaseScan:
   https://basescan.org/tx/${txHash}
   https://basescan.org/token/${IDENTITY_REGISTRY_ADDRESS}?a=${agentId}
`);

  console.log("✨ Registration complete!");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
