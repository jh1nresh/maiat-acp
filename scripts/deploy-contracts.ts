#!/usr/bin/env npx tsx
/**
 * Deploy MaiatReceiptResolver + MaiatOracle contracts to Base.
 *
 * Usage:
 *   MAIAT_PRIVATE_KEY=0x... npx tsx scripts/deploy-contracts.ts
 *
 * After deployment, add the contract addresses to .env:
 *   MAIAT_RESOLVER_ADDRESS=0x...
 *   MAIAT_ORACLE_ADDRESS=0x...
 */

import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import { createPublicClient, createWalletClient, http, type Hex, type Address } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const BASE_RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const EAS_ADDRESS: Address = "0x4200000000000000000000000000000000000021";

function loadBuildArtifact(contractName: string) {
  const buildDir = path.join(import.meta.dirname, "..", "contracts", "build");
  const abiPath = path.join(buildDir, `${contractName}.abi`);
  const binPath = path.join(buildDir, `${contractName}.bin`);

  if (!fs.existsSync(abiPath) || !fs.existsSync(binPath)) {
    throw new Error(
      `Build artifacts not found for ${contractName}. Run: npx solcjs --abi --bin --optimize contracts/*.sol -o contracts/build`
    );
  }

  const abi = JSON.parse(fs.readFileSync(abiPath, "utf-8"));
  const bytecode = ("0x" + fs.readFileSync(binPath, "utf-8").trim()) as Hex;

  return { abi, bytecode };
}

async function main() {
  console.log("\n  Maiat Contract Deployment");
  console.log("  " + "=".repeat(50));

  const rawPk = process.env.DEPLOY_PRIVATE_KEY ?? process.env.MAIAT_PRIVATE_KEY ?? "";
  const pk = (rawPk.startsWith("0x") ? rawPk : `0x${rawPk}`) as Hex;
  if (!rawPk) {
    console.error("  ❌ DEPLOY_PRIVATE_KEY (or MAIAT_PRIVATE_KEY) is required");
    console.error("     Usage: DEPLOY_PRIVATE_KEY=0x... npx tsx scripts/deploy-contracts.ts\n");
    process.exit(1);
  }

  const account = privateKeyToAccount(pk);
  console.log(`  Deployer:  ${account.address}`);
  console.log(`  Chain:     Base (8453)`);
  console.log(`  EAS:       ${EAS_ADDRESS}\n`);

  const publicClient = createPublicClient({ chain: base, transport: http(BASE_RPC) });
  const walletClient = createWalletClient({ account, chain: base, transport: http(BASE_RPC) });

  const ACP_WALLET = "0xB1e504aE1ce359B4C2a6DC5d63aE6199a415f312" as const;
  console.log(`  ACP Wallet: ${ACP_WALLET} (operator/attester)\n`);

  // ── 1. Deploy MaiatReceiptResolver ──────────────────────────────────
  console.log("  [1/2] Deploying MaiatReceiptResolver...");
  const resolver = loadBuildArtifact("contracts_MaiatReceiptResolver_sol_MaiatReceiptResolver");

  const resolverHash = await walletClient.deployContract({
    abi: resolver.abi,
    bytecode: resolver.bytecode,
    args: [EAS_ADDRESS, ACP_WALLET], // eas, maiatAttester = ACP hot wallet
  });

  console.log(`        TX: ${resolverHash}`);
  const resolverReceipt = await publicClient.waitForTransactionReceipt({ hash: resolverHash });
  const resolverAddress = resolverReceipt.contractAddress!;
  console.log(`        ✅ Resolver deployed: ${resolverAddress}\n`);

  // ── 2. Deploy MaiatOracle ───────────────────────────────────────────
  console.log("  [2/2] Deploying MaiatOracle...");
  const oracle = loadBuildArtifact("contracts_MaiatOracle_sol_MaiatOracle");

  const oracleHash = await walletClient.deployContract({
    abi: oracle.abi,
    bytecode: oracle.bytecode,
    args: [ACP_WALLET], // operator = ACP hot wallet (owner = deployer msg.sender)
  });

  console.log(`        TX: ${oracleHash}`);
  const oracleReceipt = await publicClient.waitForTransactionReceipt({ hash: oracleHash });
  const oracleAddress = oracleReceipt.contractAddress!;
  console.log(`        ✅ Oracle deployed: ${oracleAddress}\n`);

  // ── Summary ─────────────────────────────────────────────────────────
  console.log("  " + "=".repeat(50));
  console.log("  ✅ All contracts deployed!\n");
  console.log("  Add to .env:");
  console.log(`    MAIAT_RESOLVER_ADDRESS=${resolverAddress}`);
  console.log(`    MAIAT_ORACLE_ADDRESS=${oracleAddress}\n`);
  console.log("  Next: Re-register EAS schema with resolver:");
  console.log("    MAIAT_PRIVATE_KEY=0x... npm run eas:re-register\n");
}

main().catch((err) => {
  console.error("\n  ❌ Deployment failed:", err.message || err);
  process.exit(1);
});
