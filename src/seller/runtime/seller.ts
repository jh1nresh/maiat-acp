#!/usr/bin/env npx tsx
// =============================================================================
// Seller runtime — main entrypoint.
//
// Usage:
//   npx tsx src/seller/runtime/seller.ts
//   (or)  acp serve start
// =============================================================================

import { connectAcpSocket } from "./acpSocket.js";
import { acceptOrRejectJob, requestPayment, deliverJob, evaluateJob } from "./sellerApi.js";
import { loadOffering, listOfferings } from "./offerings.js";
import { AcpJobPhase, type AcpJobEventData } from "./types.js";
import type { ExecuteJobResult } from "./offeringTypes.js";
import { getMyAgentInfo } from "../../lib/wallet.js";
import {
  createAttestation,
  isEasEnabled,
  updateOracle,
  isOracleEnabled,
  type AttestationData,
} from "../../lib/eas.js";

const MAIAT_REVIEW_URL = process.env.MAIAT_REVIEW_URL || "https://app.maiat.io/api/v1/review";
const MAIAT_API_URL = process.env.MAIAT_API_URL || "https://app.maiat.io/api/v1";
const MAIAT_EVALUATOR_MIN_SCORE = Number(process.env.MAIAT_EVALUATOR_MIN_SCORE || "30");
const MAIAT_EVALUATOR_AUTO_APPROVE_SCORE = Number(
  process.env.MAIAT_EVALUATOR_AUTO_APPROVE_SCORE || "80"
);

// Garbage deliverable patterns — too short or meaningless
const GARBAGE_PATTERNS = new Set([
  "hello",
  "hi",
  "test",
  "ok",
  "done",
  "yes",
  "no",
  "{}",
  "[]",
  "null",
  "undefined",
  "none",
]);

/**
 * Post an automated behavioral review after successfully completing a job.
 * The buyer (clientAddress) gets reviewed by Maiat (our wallet).
 */
async function postAutoReview(
  clientAddress: string,
  maiatWallet: string,
  offeringName: string,
  jobId: number
) {
  const rating = 7; // Default positive rating for completed jobs
  const comment = `Automated review: ${offeringName} job #${jobId} completed successfully.`;

  const res = await fetch(MAIAT_REVIEW_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Maiat-Client": "maiat-acp-seller",
    },
    body: JSON.stringify({
      address: clientAddress,
      rating,
      comment,
      reviewer: maiatWallet,
      source: "agent",
      tags: ["acp", offeringName, "auto"],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    // Non-critical: skip gracefully if address is unknown (not in Maiat DB yet)
    if (res.status === 400 && text.includes("not a known agent")) {
      console.log(`[seller] Auto-review skipped — ${clientAddress} not in Maiat DB (job ${jobId})`);
      return;
    }
    throw new Error(`Review API ${res.status}: ${text}`);
  }

  console.log(`[seller] Auto-review posted for ${clientAddress} (job ${jobId}, ${offeringName})`);
}
import {
  checkForExistingProcess,
  writePidToConfig,
  removePidFromConfig,
  sanitizeAgentName,
} from "../../lib/config.js";

function setupCleanupHandlers(): void {
  const cleanup = () => {
    removePidFromConfig();
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.on("uncaughtException", (err) => {
    console.error("[seller] Uncaught exception:", err);
    cleanup();
    process.exit(1);
  });
  process.on("unhandledRejection", (reason, promise) => {
    console.error("[seller] Unhandled rejection at:", promise, "reason:", reason);
    cleanup();
    process.exit(1);
  });
}

// -- Config --

const ACP_URL = process.env.ACP_SOCKET_URL || "https://acpx.virtuals.io";
let agentDirName: string = "";
let sellerWalletAddress: string = "";

// -- Evaluator logic --

interface TrustCheckResult {
  score: number;
  verdict: string;
  completionRate?: number;
  totalJobs?: number;
}

async function checkProviderTrust(address: string): Promise<TrustCheckResult> {
  if (!address || !address.startsWith("0x")) {
    return { score: 0, verdict: "unknown" };
  }

  try {
    const resp = await fetch(`${MAIAT_API_URL}/agent/${address}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as Record<string, unknown>;
    return {
      score: (data.trustScore ?? data.score ?? 0) as number,
      verdict: (data.verdict ?? "unknown") as string,
      completionRate: data.completionRate as number | undefined,
      totalJobs: data.totalJobs as number | undefined,
    };
  } catch (err) {
    console.warn(`[evaluator] Trust check failed for ${address}:`, err);
    return { score: 0, verdict: "unknown" };
  }
}

function isGarbageDeliverable(deliverable: string): boolean {
  if (!deliverable?.trim()) return true;
  const cleaned = deliverable.trim();
  if (cleaned.length < 20) return true;
  if (GARBAGE_PATTERNS.has(cleaned.toLowerCase())) return true;
  return false;
}

function extractDeliverable(data: AcpJobEventData): string {
  // Find the COMPLETED memo (deliverable submission)
  const completedMemo = data.memos.find((m) => m.nextPhase === AcpJobPhase.COMPLETED);
  return completedMemo?.content ?? "";
}

async function handleEvaluate(data: AcpJobEventData): Promise<void> {
  const jobId = data.id;

  console.log(`\n${"=".repeat(60)}`);
  console.log(
    `[evaluator] Evaluating job ${jobId}  phase=${AcpJobPhase[data.phase] ?? data.phase}`
  );
  console.log(`            provider=${data.providerAddress}  client=${data.clientAddress}`);
  console.log(`${"=".repeat(60)}`);

  const deliverable = extractDeliverable(data);
  const providerAddress = data.providerAddress;

  // Step 1: Garbage check
  if (isGarbageDeliverable(deliverable)) {
    console.warn(`[evaluator] Job ${jobId}: Garbage deliverable — rejecting`);
    await evaluateJob(jobId, {
      accept: false,
      reason: "Deliverable is empty or too short to be valid work",
    });
    await recordEvaluationOutcome(jobId, providerAddress, false, "garbage");
    return;
  }

  // Step 2: Trust score check
  const trust = await checkProviderTrust(providerAddress);
  console.log(
    `[evaluator] Job ${jobId}: Provider trust score=${trust.score} verdict=${trust.verdict}`
  );

  if (trust.verdict === "avoid" || trust.score < MAIAT_EVALUATOR_MIN_SCORE) {
    console.warn(
      `[evaluator] Job ${jobId}: Provider untrusted (score=${trust.score}, verdict=${trust.verdict}) — rejecting`
    );
    await evaluateJob(jobId, {
      accept: false,
      reason: `Provider trust too low: score=${trust.score}, verdict=${trust.verdict}`,
    });
    await recordEvaluationOutcome(jobId, providerAddress, false, "low_trust");
    return;
  }

  // Step 3: Auto-approve trusted providers
  if (trust.score >= MAIAT_EVALUATOR_AUTO_APPROVE_SCORE) {
    console.log(`[evaluator] Job ${jobId}: Auto-approved (trusted provider, score=${trust.score})`);
    await evaluateJob(jobId, {
      accept: true,
      reason: `Maiat-verified: trusted provider (score=${trust.score})`,
    });
    await recordEvaluationOutcome(jobId, providerAddress, true, "auto_approved");

    // EAS attestation + Oracle update for evaluated jobs
    await postEvaluationOnChain(deliverable, providerAddress, jobId);
    return;
  }

  // Step 4: Moderate trust — approve with note
  console.log(`[evaluator] Job ${jobId}: Approved with moderate trust (score=${trust.score})`);
  await evaluateJob(jobId, {
    accept: true,
    reason: `Maiat-verified: moderate trust (score=${trust.score})`,
  });
  await recordEvaluationOutcome(jobId, providerAddress, true, "moderate_approved");
  await postEvaluationOnChain(deliverable, providerAddress, jobId);
}

async function recordEvaluationOutcome(
  jobId: number,
  provider: string,
  approved: boolean,
  reason: string
): Promise<void> {
  try {
    await fetch(`${MAIAT_API_URL}/outcome`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: String(jobId),
        provider,
        approved,
        reason,
        source: "maiat-acp-evaluator",
      }),
    });
  } catch {
    // Best effort — don't block evaluation
  }
}

async function postEvaluationOnChain(
  deliverable: string,
  providerAddress: string,
  jobId: number
): Promise<void> {
  try {
    const parsed = typeof deliverable === "string" ? JSON.parse(deliverable) : deliverable;
    const score =
      typeof parsed.score === "number"
        ? parsed.score
        : typeof parsed.trustScore === "number"
          ? parsed.trustScore
          : null;

    if (score === null) return;

    const attestData: AttestationData = {
      agent: providerAddress as `0x${string}`,
      score: Math.min(255, Math.max(0, Math.round(score))),
      verdict: parsed.verdict || "unknown",
      offering: "evaluator",
      jobId,
      riskSummary: parsed.riskSummary || "",
    };

    if (isEasEnabled()) {
      await createAttestation(attestData).catch((err: Error) =>
        console.error(`[evaluator] EAS attestation failed for job ${jobId}:`, err.message)
      );
    }

    if (isOracleEnabled()) {
      await updateOracle(attestData).catch((err: Error) =>
        console.error(`[evaluator] Oracle update failed for job ${jobId}:`, err.message)
      );
    }
  } catch {
    // Deliverable may not be JSON with score — that's fine
  }
}

// -- Job handling --

function resolveOfferingName(data: AcpJobEventData): string | undefined {
  try {
    const negotiationMemo = data.memos.find((m) => m.nextPhase === AcpJobPhase.NEGOTIATION);
    if (negotiationMemo) {
      return JSON.parse(negotiationMemo.content).name;
    }
  } catch {
    return undefined;
  }
}

function resolveServiceRequirements(data: AcpJobEventData): Record<string, any> {
  const negotiationMemo = data.memos.find((m) => m.nextPhase === AcpJobPhase.NEGOTIATION);
  if (negotiationMemo) {
    try {
      return JSON.parse(negotiationMemo.content).requirement;
    } catch {
      return {};
    }
  }
  return {};
}

async function handleNewTask(data: AcpJobEventData): Promise<void> {
  const jobId = data.id;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`[seller] New task  jobId=${jobId}  phase=${AcpJobPhase[data.phase] ?? data.phase}`);
  console.log(`         client=${data.clientAddress}  price=${data.price}`);
  console.log(`         context=${JSON.stringify(data.context)}`);
  console.log(`${"=".repeat(60)}`);

  // Step 1: Accept / reject
  if (data.phase === AcpJobPhase.REQUEST) {
    if (!data.memoToSign) {
      return;
    }

    const negotiationMemo = data.memos.find((m) => m.id == Number(data.memoToSign));

    if (negotiationMemo?.nextPhase !== AcpJobPhase.NEGOTIATION) {
      return;
    }

    const offeringName = resolveOfferingName(data);
    const requirements = resolveServiceRequirements(data);

    if (!offeringName) {
      await acceptOrRejectJob(jobId, {
        accept: false,
        reason: "Invalid offering name",
      });
      return;
    }

    try {
      const { config, handlers } = await loadOffering(offeringName, agentDirName);

      if (handlers.validateRequirements) {
        const validationResult = handlers.validateRequirements(requirements);

        let isValid: boolean;
        let reason: string | undefined;

        if (typeof validationResult === "boolean") {
          isValid = validationResult;
          reason = isValid ? undefined : "Validation failed";
        } else {
          isValid = validationResult.valid;
          reason = validationResult.reason;
        }

        if (!isValid) {
          const rejectionReason = reason || "Validation failed";
          console.log(
            `[seller] Validation failed for offering "${offeringName}" — rejecting: ${rejectionReason}`
          );
          await acceptOrRejectJob(jobId, {
            accept: false,
            reason: rejectionReason,
          });
          return;
        }
      }

      await acceptOrRejectJob(jobId, {
        accept: true,
        reason: "Job accepted",
      });

      const funds =
        config.requiredFunds && handlers.requestAdditionalFunds
          ? handlers.requestAdditionalFunds(requirements)
          : undefined;

      const paymentReason = handlers.requestPayment
        ? handlers.requestPayment(requirements)
        : (funds?.content ?? "Request accepted");

      await requestPayment(jobId, {
        content: paymentReason,
        payableDetail: funds
          ? {
              amount: funds.amount,
              tokenAddress: funds.tokenAddress,
              recipient: funds.recipient,
            }
          : undefined,
      });
    } catch (err) {
      console.error(`[seller] Error processing job ${jobId}:`, err);
    }
  }

  // Handle TRANSACTION (deliver)
  if (data.phase === AcpJobPhase.TRANSACTION) {
    const offeringName = resolveOfferingName(data);
    const requirements = resolveServiceRequirements(data);

    if (offeringName) {
      try {
        const { handlers } = await loadOffering(offeringName, agentDirName);
        console.log(
          `[seller] Executing offering "${offeringName}" for job ${jobId} (TRANSACTION phase)...`
        );
        // Inject client wallet into requirements so handlers (e.g. trust_swap) can auto-use it
        const enrichedRequirements = {
          ...requirements,
          _clientAddress: data.clientAddress,
          swapper: requirements.swapper || data.clientAddress,
        };
        const result: ExecuteJobResult = await handlers.executeJob(enrichedRequirements);

        await deliverJob(jobId, {
          deliverable: result.deliverable,
          payableDetail: result.payableDetail,
        });
        console.log(`[seller] Job ${jobId} — delivered.`);

        // Auto-post behavioral review to Maiat Protocol
        postAutoReview(data.clientAddress, sellerWalletAddress, offeringName, jobId).catch((err) =>
          console.error(`[seller] Auto-review failed for job ${jobId}:`, err.message)
        );
        // Update on-chain EAS and Oracle sequentially (non-blocking to main thread)
        (async () => {
          if (isEasEnabled()) {
            await tryCreateAttestation(
              result.deliverable,
              data.clientAddress,
              offeringName,
              jobId
            ).catch((err) =>
              console.error(`[seller] EAS attestation failed for job ${jobId}:`, err.message)
            );
          }
          if (isOracleEnabled()) {
            await tryUpdateOracle(
              result.deliverable,
              data.clientAddress,
              offeringName,
              jobId
            ).catch((err) =>
              console.error(`[seller] Oracle update failed for job ${jobId}:`, err.message)
            );
          }
        })();
      } catch (err) {
        console.error(`[seller] Error delivering job ${jobId}:`, err);
      }
    } else {
      console.log(`[seller] Job ${jobId} in TRANSACTION but no offering resolved — skipping`);
    }
    return;
  }

  console.log(
    `[seller] Job ${jobId} in phase ${AcpJobPhase[data.phase] ?? data.phase} — no action needed`
  );
}

// -- EAS helper --

/**
 * Attempt to create an EAS attestation from the job deliverable.
 * Parses the deliverable JSON for score/verdict/riskSummary fields.
 */
async function tryCreateAttestation(
  deliverable: string | { type: string; value: unknown },
  clientAddress: string,
  offeringName: string,
  jobId: number
): Promise<void> {
  try {
    const parsed = typeof deliverable === "string" ? JSON.parse(deliverable) : deliverable;

    const score =
      typeof parsed.score === "number"
        ? parsed.score
        : typeof parsed.trustScore === "number"
          ? parsed.trustScore
          : null;

    if (score === null) return; // No score to attest

    const attestData: AttestationData = {
      agent: clientAddress as `0x${string}`,
      score: Math.min(255, Math.max(0, Math.round(score))),
      verdict: parsed.verdict || "unknown",
      offering: offeringName,
      jobId,
      riskSummary: parsed.riskSummary || "",
    };

    await createAttestation(attestData);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[eas] Failed to parse deliverable for attestation: ${msg}`);
  }
}

/**
 * Attempt to update the MaiatOracle from the job deliverable.
 */
async function tryUpdateOracle(
  deliverable: string | { type: string; value: unknown },
  clientAddress: string,
  offeringName: string,
  jobId: number
): Promise<void> {
  try {
    const parsed = typeof deliverable === "string" ? JSON.parse(deliverable) : deliverable;

    const score =
      typeof parsed.score === "number"
        ? parsed.score
        : typeof parsed.trustScore === "number"
          ? parsed.trustScore
          : null;

    if (score === null) return;

    await updateOracle({
      agent: clientAddress as `0x${string}`,
      score: Math.min(255, Math.max(0, Math.round(score))),
      verdict: parsed.verdict || "unknown",
      offering: offeringName,
      jobId,
      riskSummary: parsed.riskSummary || "",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[oracle] Failed to parse deliverable for oracle update: ${msg}`);
  }
}

// -- Main --

async function main() {
  checkForExistingProcess();

  writePidToConfig(process.pid);

  setupCleanupHandlers();

  let walletAddress: string;
  try {
    const agentData = await getMyAgentInfo();
    walletAddress = agentData.walletAddress;
    sellerWalletAddress = walletAddress;
    agentDirName = sanitizeAgentName(agentData.name);
    console.log(`[seller] Agent: ${agentData.name} (dir: ${agentDirName})`);
  } catch (err) {
    console.error("[seller] Failed to resolve agent info:", err);
    process.exit(1);
  }

  const offerings = listOfferings(agentDirName);
  console.log(
    `[seller] Available offerings: ${offerings.length > 0 ? offerings.join(", ") : "(none)"}`
  );

  connectAcpSocket({
    acpUrl: ACP_URL,
    walletAddress,
    callbacks: {
      onNewTask: (data) => {
        handleNewTask(data).catch((err) =>
          console.error("[seller] Unhandled error in handleNewTask:", err)
        );
      },
      onEvaluate: (data) => {
        handleEvaluate(data).catch((err) =>
          console.error(`[evaluator] Unhandled error evaluating job ${data.id}:`, err)
        );
      },
    },
  });

  console.log("[seller] Seller runtime is running. Waiting for jobs...\n");
}

main().catch((err) => {
  console.error("[seller] Fatal error:", err);
  process.exit(1);
});
