/**
 * Maiat Passport Register — ACP Seller Handler
 *
 * Registers a new Maiat Passport: ENS name + on-chain ERC-8004 identity + KYA code.
 * Agents get a verifiable identity they can use across the trust network.
 */

import type { ExecuteJobResult, ValidationResult } from "../../../runtime/offeringTypes.js";

const MAIAT_API = process.env.MAIAT_API_URL || "https://app.maiat.io";

// ── Validation ────────────────────────────────────────────────────────────────
export function validateRequirements(requirements: Record<string, unknown>): ValidationResult {
  const ensName = extractEnsName(requirements);
  if (!ensName) {
    return {
      valid: false,
      reason:
        "Missing or invalid ensName. Provide a name with 3+ lowercase letters, numbers, or hyphens (e.g. 'butler', 'my-agent-42').",
    };
  }

  // Validate format
  if (!/^[a-z0-9-]{3,}$/.test(ensName)) {
    return {
      valid: false,
      reason: `Invalid ensName "${ensName}". Must be 3+ characters, lowercase letters, numbers, or hyphens only.`,
    };
  }

  return { valid: true };
}

// ── Payment message ───────────────────────────────────────────────────────────
export function requestPayment(requirements: Record<string, unknown>): string {
  const ensName = extractEnsName(requirements) || "your-agent";
  return `Registering ${ensName}.maiat.eth — you'll get an ENS name, on-chain identity, and KYA code. Please proceed with payment.`;
}

// ── Execution ─────────────────────────────────────────────────────────────────
export async function executeJob(requirements: Record<string, unknown>): Promise<ExecuteJobResult> {
  const ensName = extractEnsName(requirements);

  if (!ensName) {
    return {
      deliverable: JSON.stringify({
        error: "No valid ensName provided. Pass { ensName: 'my-agent' } as requirements.",
        registered: false,
      }),
    };
  }

  // Extract optional fields
  const walletAddress = extractString(requirements, ["walletAddress", "wallet", "address"]);
  const type = extractString(requirements, ["type"]) === "human" ? "human" : "agent";
  const referredBy = extractString(requirements, ["referredBy", "referrer", "ref"]);

  try {
    const body: Record<string, string> = { ensName, type };
    if (walletAddress && /^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      body.walletAddress = walletAddress;
    }
    if (referredBy) {
      body.referredBy = referredBy;
    }

    const res = await fetch(`${MAIAT_API}/api/v1/passport/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-maiat-client": "maiat-acp",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    const data = (await res.json()) as Record<string, unknown>;

    if (!res.ok) {
      const error =
        typeof data.error === "string" ? data.error : `Registration failed (${res.status})`;
      return {
        deliverable: JSON.stringify({
          error,
          registered: false,
          suggestion:
            res.status === 409
              ? "This name is taken. Try a different ensName."
              : res.status === 400
                ? "Invalid input. ensName must be 3+ chars, lowercase letters/numbers/hyphens."
                : "Try again or provide a walletAddress if auto-creation failed.",
        }),
      };
    }

    const passport = data.passport as Record<string, unknown> | undefined;
    const kya = data.kya as Record<string, unknown> | undefined;

    return {
      deliverable: JSON.stringify({
        registered: true,
        isNew: passport?.isNew ?? true,
        ensName: passport?.ensName,
        ensFullName: passport?.ensFullName,
        walletAddress: passport?.walletAddress,
        type: passport?.type,
        trustScore: passport?.trustScore,
        verdict: passport?.verdict,
        scarabBalance: passport?.scarabBalance,
        kyaCode: passport?.kyaCode,
        erc8004AgentId: passport?.erc8004AgentId,
        erc8004Status: passport?.erc8004Status,
        ensRegistered: passport?.ensRegistered,
        privyWalletCreated: passport?.privyWalletCreated,
        referralApplied: passport?.referralApplied,
        ...(kya ? { kya } : {}),
        _nextSteps: {
          checkTrust: `GET ${MAIAT_API}/api/v1/agent/${passport?.walletAddress}`,
          endorseUrl: kya?.shareUrl || null,
          dashboardUrl: `https://app.maiat.io/passport/${passport?.walletAddress}`,
          passportUrl: `https://passport.maiat.io/verify/${passport?.kyaCode || passport?.walletAddress}`,
          earnScarab:
            "Report outcomes (+5 🪲), write reviews (+3 🪲), vote (+1 🪲), get endorsed (+5 🪲)",
        },
        _relatedOfferings: {
          agent_trust: "Check your trust score after building history ($0.02)",
          agent_reputation: "See community reviews and sentiment ($0.03)",
          token_check: "Verify token safety before swapping ($0.01)",
        },
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      deliverable: JSON.stringify({
        error: `Registration request failed: ${message}`,
        registered: false,
      }),
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractEnsName(requirements: Record<string, unknown>): string | null {
  for (const key of ["ensName", "ens", "name", "username"]) {
    const val = requirements[key];
    if (typeof val === "string" && val.trim().length >= 3) {
      // Strip .maiat.eth suffix if provided
      return val
        .trim()
        .toLowerCase()
        .replace(/\.maiat\.eth$/, "");
    }
  }
  return null;
}

function extractString(requirements: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const val = requirements[key];
    if (typeof val === "string" && val.trim().length > 0) {
      return val.trim();
    }
  }
  return null;
}
