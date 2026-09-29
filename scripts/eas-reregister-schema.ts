#!/usr/bin/env npx tsx
/**
 * Re-register the Maiat Trust Schema with the MaiatReceiptResolver.
 *
 * Usage:
 *   MAIAT_PRIVATE_KEY=0x... npx tsx scripts/eas-reregister-schema.ts
 *
 * Requires MAIAT_RESOLVER_ADDRESS in .env (from deploy-contracts.ts).
 * After registration, update EAS_SCHEMA_UID in .env with the new UID.
 */

import dotenv from "dotenv";
dotenv.config();

import { createPublicClient, createWalletClient, http, type Hex, type Address } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const BASE_RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";

const SCHEMA_REGISTRY_ADDRESS: Address = "0x4200000000000000000000000000000000000020";
const SCHEMA_STRING =
  "address agent,uint8 score,string verdict,string offering,uint256 jobId,string riskSummary";

const SCHEMA_REGISTRY_ABI = [
  {
    name: "register",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "schema", type: "string" },
      { name: "resolver", type: "address" },
      { name: "revocable", type: "bool" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

async function main() {
  console.log("\n  EAS Schema Re-Registration (with Resolver)");
  console.log("  " + "=".repeat(50));

  const rawPk = process.env.DEPLOY_PRIVATE_KEY ?? process.env.MAIAT_PRIVATE_KEY ?? "";
  const pk = (rawPk.startsWith("0x") ? rawPk : `0x${rawPk}`) as Hex;
  const resolverAddress = process.env.MAIAT_RESOLVER_ADDRESS as Address | undefined;

  if (!rawPk) {
    console.error("  ❌ MAIAT_PRIVATE_KEY is required");
    process.exit(1);
  }
  if (!resolverAddress) {
    console.error("  ❌ MAIAT_RESOLVER_ADDRESS is required (run deploy-contracts.ts first)");
    process.exit(1);
  }

  console.log(`  Schema Registry: ${SCHEMA_REGISTRY_ADDRESS}`);
  console.log(`  Resolver:        ${resolverAddress}`);
  console.log(`  Schema:          ${SCHEMA_STRING}`);
  console.log(`  Chain:           Base (8453)\n`);
  console.log("  Registering schema with resolver...\n");

  const account = privateKeyToAccount(pk);
  const publicClient = createPublicClient({ chain: base, transport: http(BASE_RPC) });
  const walletClient = createWalletClient({ account, chain: base, transport: http(BASE_RPC) });

  const txHash = await walletClient.writeContract({
    address: SCHEMA_REGISTRY_ADDRESS,
    abi: SCHEMA_REGISTRY_ABI,
    functionName: "register",
    args: [SCHEMA_STRING, resolverAddress, false], // non-revocable
  });

  console.log(`  TX: ${txHash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  const registeredLog = receipt.logs.find(
    (log) => log.address.toLowerCase() === SCHEMA_REGISTRY_ADDRESS.toLowerCase()
  );
  const schemaUID = registeredLog?.topics?.[1] as Hex | undefined;

  console.log("\n  ✅ Schema registered with resolver!");
  console.log(`  Schema UID: ${schemaUID}`);
  console.log(`\n  Update .env:\n    EAS_SCHEMA_UID=${schemaUID}\n`);
}

main().catch((err) => {
  console.error("\n  ❌ Failed:", err.message || err);
  process.exit(1);
});
