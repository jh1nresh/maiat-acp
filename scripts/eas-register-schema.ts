#!/usr/bin/env npx tsx
/**
 * Register the Maiat Trust Attestation schema on Base EAS.
 *
 * Usage:
 *   MAIAT_PRIVATE_KEY=0x... npx tsx scripts/eas-register-schema.ts
 *
 * This only needs to run ONCE. After registration, copy the schema UID
 * and set it as EAS_SCHEMA_UID in your .env file.
 */

import dotenv from "dotenv";
dotenv.config();

import { registerSchema, getSchemaString, SCHEMA_REGISTRY_ADDRESS } from "../src/lib/eas.js";

async function main() {
  console.log("\n  EAS Schema Registration");
  console.log("  " + "=".repeat(50));
  console.log(`  Schema Registry: ${SCHEMA_REGISTRY_ADDRESS}`);
  console.log(`  Schema:          ${getSchemaString()}`);
  console.log(`  Chain:           Base (8453)\n`);

  if (!process.env.MAIAT_PRIVATE_KEY) {
    console.error("  ❌ MAIAT_PRIVATE_KEY environment variable is required");
    console.error("     Usage: MAIAT_PRIVATE_KEY=0x... npx tsx scripts/eas-register-schema.ts\n");
    process.exit(1);
  }

  console.log("  Registering schema...\n");

  const schemaUID = await registerSchema();

  if (schemaUID) {
    console.log("\n  ✅ Schema registered successfully!");
    console.log(`  Schema UID: ${schemaUID}`);
    console.log(`\n  Add to .env:\n    EAS_SCHEMA_UID=${schemaUID}\n`);
  } else {
    console.error("\n  ❌ Schema registration failed. Check logs above.\n");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
