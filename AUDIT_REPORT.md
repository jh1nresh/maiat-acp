# Maiat ACP — Security Audit Report
**Auditor:** Pashov-style internal review  
**Date:** 2026-03-18  
**Commit ref:** HEAD (`~/maiat-acp`)  
**Scope:** `MaiatEvaluator.sol`, `MaiatHook.sol`, `interfaces/IAgenticCommerce.sol`  
**Reference (read-only):** `MaiatOracle.sol`, `MaiatReceiptResolver.sol`  
**Test suite:** `forge test` — **135/135 passing**

---

## Executive Summary

The Maiat ACP contracts implement a dual-review commit-reveal evaluation system with EAS attestation receipts and oracle-gated trust scores. The overall architecture is sound and shows security awareness (CEI pattern attempts, zero-address guards, onlyOperator/onlyOwner separation). However, the audit identified **2 High**, **5 Medium**, **3 Low**, and **4 Informational** findings. The most critical issues are a reentrancy window in `evaluate()` and the complete absence of reveal deadlines, which can permanently freeze user funds.

---

## Findings

### [H-1] `evaluate()` sets `record.evaluated` AFTER external call to `eas.attest()` — reentrancy window

**Severity:** High  
**Contract:** `MaiatEvaluator.sol`  
**Function:** `evaluate()`

**Description:**  
`evaluate()` calls the external `eas.attest()` inside `_issueAttestation()` before setting `record.evaluated = true`. At the time of the EAS call, the guard against re-evaluation is not yet active. A malicious or compromised EAS contract could re-enter `evaluate()` for the same `jobId`, pass all checks (the job is still `Submitted`, `record.evaluated` is still `false`), issue a second attestation, call `acp.complete()` twice, and increment `evaluationCount` twice.

```solidity
// ❌ External call before state mutation
bytes32 attestationUid = _issueAttestation(jobId, job, finalScore, ...); // ← eas.attest() called here

// ← record.evaluated is STILL false at this point
record.attestationUid = attestationUid;
record.evaluated = true;   // ← only set after external call
record.evaluatedAt = uint64(block.timestamp);
evaluationCount++;

// Second external call — also after the guard
if (finalScore >= APPROVAL_THRESHOLD) {
    acp.complete(jobId, ...);
}
```

**Impact:**  
- Double invocation of `acp.complete()` or `acp.reject()`, potentially paying the provider twice or incorrectly double-rejecting.  
- `evaluationCount` inflated; attestation UID overwritten with the re-entrant call's UID then overwritten again by the outer call, silently losing the receipt chain.  
- Unlikely with canonical EAS on Base, but the invariant is broken and becomes exploitable if EAS is ever upgraded or pointed to a mock/proxy.

**Proof of Concept:**
```
Attacker deploys MaliciousEAS:
  attest() {
    if (reentering) return uid2;
    reentering = true;
    evaluator.evaluate(jobId);  // re-enters here while record.evaluated == false
    return uid1;
  }
Constructor: pass MaliciousEAS as `_eas`
Operator calls evaluate(jobId) → acp.complete() called twice
```

**Recommendation:**  
Move `record.evaluated = true` to before **all** external calls, immediately after the sanity checks:

```solidity
// ✅ Set guard before any external interaction
record.evaluated = true;
record.evaluatedAt = uint64(block.timestamp);
evaluationCount++;

bytes32 attestationUid = _issueAttestation(jobId, job, finalScore, approved);
record.attestationUid = attestationUid;
record.finalScore = finalScore;

emit JobEvaluated(jobId, finalScore, approved, attestationUid, record.evaluatedAt);

if (finalScore >= APPROVAL_THRESHOLD) {
    acp.complete(jobId, _buildCompletionReason(finalScore), "");
} else {
    acp.reject(jobId, _buildRejectionReason(finalScore), "");
}
```

---

### [H-2] No reveal deadline — either party can permanently block evaluation and freeze escrow

**Severity:** High  
**Contract:** `MaiatEvaluator.sol`  
**Functions:** `commitReview()`, `revealReview()`

**Description:**  
The commit-reveal flow has no deadline. `revealReview()` requires both parties to have committed before either can reveal, but there is no time limit on committing or revealing. A malicious (or unresponsive) party can:

1. **Commit-then-never-reveal:** Commit an unfavourable rating, then refuse to call `revealReview()`. Since the other party cannot reveal without both having committed (and reveals require matching commitments), the evaluation is permanently stuck.  
2. **Never-commit:** Simply never call `commitReview()`. The other party cannot proceed.

In both cases, the job stays in `Submitted` state forever (or until ACP-level expiry, which is out of scope), escrow funds remain locked, and there is no on-chain escape hatch.

**Impact:**  
- Permanent DoS on evaluation for any job.  
- Client's escrowed budget is frozen indefinitely.  
- Provider who has already delivered work cannot be paid.  
- Grief vector: a losing party (low AI score expected) can commit and refuse to reveal to avoid the on-chain rejection record.

**Recommendation:**  
Add a reveal deadline. After `REVEAL_WINDOW` seconds since the second commit, allow the operator (or either party) to call an emergency path that either:
- Forces evaluation using only available scores (treating non-revealers as 0), or  
- Triggers an auto-rejection / escrow-refund.

```solidity
uint64 public constant REVEAL_WINDOW = 7 days;
mapping(uint256 => uint64) public commitDeadline; // set when second commit lands

// In commitReview(), when second party commits:
if (areBothReviewsCommitted(jobId)) {
    commitDeadline[jobId] = uint64(block.timestamp) + REVEAL_WINDOW;
}

// New function:
function forceEvaluateAfterDeadline(uint256 jobId) external onlyOperator {
    require(block.timestamp > commitDeadline[jobId], "Deadline not reached");
    // treat un-revealed review as 0
}
```

---

### [M-1] `evaluate()` proceeds with default `aiQualityScore = 0` when `submitAIScore` was never called

**Severity:** Medium  
**Contract:** `MaiatEvaluator.sol`  
**Function:** `evaluate()`

**Description:**  
`aiQualityScore` is a `uint8` field initialized to `0` by default. There is no boolean flag or other sentinel to distinguish "AI score explicitly set to 0" from "AI score never submitted." The code's own comment acknowledges this gap:

```solidity
// Check AI score is set (can be 0, but must have been explicitly set)
// We use a sentinel: ... we need a separate flag. For simplicity, we require ...
// The AI score submission emits an event, so we trust the flow
```

An operator who calls `evaluate()` without first calling `submitAIScore()` silently applies an AI quality score of **0** with a **50% weight**. The effect on border-line jobs is severe:

| providerRating | clientRating | aiScore (intended) | aiScore (actual) | finalScore |
|---|---|---|---|---|
| 100 | 100 | 60 | 0 | (10·100 + 40·100 + 50·0)/100 = **50** ❌ |
| 80 | 80 | 70 | 0 | (800+3200+0)/100 = **40** ❌ |

**Impact:**  
- Legitimate jobs silently rejected due to unchecked omission.  
- If the operator pipeline has a bug (e.g., AI score submission step fails silently), every subsequent job evaluation is wrong.  
- No on-chain revert; no visible error — the job simply receives a wrong score with a valid-looking attestation.

**Recommendation:**  
Add an explicit flag:

```solidity
bool public aiScoreSubmitted;  // per-record inside EvaluationRecord
// or:
mapping(uint256 => bool) public aiScoreSet;
```

In `evaluate()`, guard with:
```solidity
if (!record.aiScoreSet) revert AIScoreNotSet();
```

Note: the existing `AIScoreNotSet` error is **already declared** but **never used** — connect it to this check.

---

### [M-2] `oracle` is mutable in `MaiatHook` — trust gating can be silently bypassed

**Severity:** Medium  
**Contract:** `MaiatHook.sol`  
**Function:** `setOracle()`

**Description:**  
`MaiatEvaluator` stores its oracle reference as `immutable`. `MaiatHook` stores it as a **mutable state variable** that can be swapped at any time by `owner` via `setOracle()`. A compromised or malicious hook owner could point `oracle` to a contract that unconditionally returns `score = 100` for all addresses, bypassing trust-score enforcement entirely for `fund()`.

```solidity
MaiatOracle public oracle;  // NOT immutable — can be swapped
```

**Impact:**  
- Any provider (including blacklisted ones) can fund jobs if the hook oracle is replaced.  
- The trust-gating guarantee that the hook is designed to provide can be voided unilaterally by the hook owner.

**Recommendation:**  
Make `oracle` immutable, matching the pattern in `MaiatEvaluator`. If oracle upgrades are needed, deploy a new hook and have the ACP contract point to it. At minimum, add a timelock on oracle changes:

```solidity
MaiatOracle public immutable oracle;  // ✅
```

---

### [M-3] No staleness check on oracle trust scores

**Severity:** Medium  
**Contracts:** `MaiatEvaluator.sol`, `MaiatHook.sol`

**Description:**  
Both contracts read `oracle.getTrustScore(provider)` and use the returned score without checking `updatedAt`. `MaiatOracle` stores a `uint64 updatedAt` timestamp, but neither consumer validates it. A trust score from months ago is treated identically to one issued minutes ago.

**Impact:**  
- A provider whose behaviour degraded after their last score update can still pass trust gates.  
- If the oracle operator's key is compromised and a false high score is issued, it persists indefinitely.  
- Especially risky for `MaiatHook`, which gates real money transfers.

**Recommendation:**  
Add a configurable `maxTrustScoreAge` and validate:

```solidity
uint64 public maxTrustScoreAge = 30 days;

(uint8 trustScore,, uint64 updatedAt) = oracle.getTrustScore(job.provider);
if (block.timestamp - updatedAt > maxTrustScoreAge) revert TrustScoreStale();
if (trustScore < minScore) revert TrustScoreTooLow(trustScore, minScore);
```

---

### [M-4] Single operator controls the entire evaluation pipeline — no multisig or timelock

**Severity:** Medium  
**Contracts:** `MaiatEvaluator.sol`, `MaiatOracle.sol`

**Description:**  
A single EOA `operator` can:
- Set evaluation policies for any job (`setPolicy`)
- Submit AI scores for any job (`submitAIScore`)
- Trigger the final evaluation that pays or rejects providers (`evaluate`)
- Update all trust scores in `MaiatOracle` (`updateScore`, `batchUpdateScores`)

If the operator key is compromised, an attacker can reject all outstanding jobs, pay providers for undelivered work, or poison the oracle.

**Impact:**  
- Total protocol compromise with a single private key leak.  
- No cooldown, no dispute mechanism, no secondary approval.

**Recommendation:**  
- Use a multisig (e.g., Gnosis Safe) as the operator address.  
- Consider separating concerns: one role for oracle writes, another for evaluation triggers.  
- Add a timelock for policy changes.

---

### [M-5] Single-step ownership transfer — no pending-owner confirmation

**Severity:** Medium  
**Contracts:** `MaiatEvaluator.sol`, `MaiatOracle.sol`, `MaiatHook.sol`, `MaiatReceiptResolver.sol`

**Description:**  
`transferOwnership()` in all four contracts immediately sets `owner = _newOwner`. A typo or copy-paste error in the new owner address permanently locks the contract's admin functions.

**Recommendation:**  
Use the standard two-step pattern (OpenZeppelin `Ownable2Step`):

```solidity
address public pendingOwner;

function transferOwnership(address _newOwner) external onlyOwner {
    pendingOwner = _newOwner;
    emit OwnershipTransferStarted(owner, _newOwner);
}

function acceptOwnership() external {
    require(msg.sender == pendingOwner, "Not pending owner");
    emit OwnershipTransferred(owner, pendingOwner);
    owner = pendingOwner;
    pendingOwner = address(0);
}
```

---

### [L-1] `evaluationSchema` not validated against `bytes32(0)` in constructor

**Severity:** Low  
**Contract:** `MaiatEvaluator.sol`

**Description:**  
The constructor validates all address parameters against `address(0)` but does not check `_evaluationSchema != bytes32(0)`. An EAS schema of zero is either invalid or maps to a non-existent schema. If deployed with a zero schema, `eas.attest()` will revert on every evaluation, permanently blocking the contract.

**Recommendation:**
```solidity
if (_evaluationSchema == bytes32(0)) revert ZeroAddress(); // or a dedicated InvalidSchema error
```

---

### [L-2] `FundingBlocked` event declared but never emitted

**Severity:** Low  
**Contract:** `MaiatHook.sol`

**Description:**  
The `FundingBlocked` event is declared:

```solidity
event FundingBlocked(uint256 indexed jobId, address indexed provider, uint8 trustScore, uint8 required);
```

But `_checkProviderTrust()` reverts with a custom error and never emits this event. Off-chain monitoring systems that listen for `FundingBlocked` to audit blocked providers will see nothing.

**Recommendation:**  
Emit the event before reverting, or remove the dead declaration:

```solidity
function _checkProviderTrust(uint256 jobId) internal view {
    ...
    if (trustScore < minScore) {
        emit FundingBlocked(jobId, job.provider, trustScore, minScore); // ← add this
        revert TrustScoreTooLow(trustScore, minScore);
    }
}
```

Note: emitting events in `view` functions is not allowed in Solidity — change `_checkProviderTrust` to non-`view` if this emission is desired, or document the event as intentionally unused.

---

### [L-3] Expired jobs leave commit-reveal state orphaned with no cleanup path

**Severity:** Low  
**Contract:** `MaiatEvaluator.sol`

**Description:**  
`commitReview()` only allows commits when `job.status == Submitted`. However, `revealReview()` has **no job status check**. If a job transitions to `Expired` (e.g., via ACP-level expiry), parties can still reveal their committed reviews — but `evaluate()` will revert with `InvalidJobStatus` because the job is no longer `Submitted`. The result is orphaned on-chain state (revealed reviews with no evaluation possible) and wasted gas.

**Impact:**  
- Mild: gas wasted on reveals that can never be used.  
- Moderate: if the ACP contract later reuses job IDs, stale review state could interfere with future evaluations for the same ID.

**Recommendation:**  
- Add a status check in `revealReview()` or a dedicated `cancelEvaluation()` function to clean up orphaned state.  
- Alternatively, document the expected job lifecycle clearly.

---

### [I-1] `revoke()` and `multiRevoke()` in `MaiatReceiptResolver` lack `onlyEAS` modifier

**Severity:** Informational  
**Contract:** `MaiatReceiptResolver.sol`

**Description:**  
`attest()` and `multiAttest()` correctly restrict to `onlyEAS`. But `revoke()` and `multiRevoke()` have no access control — any address can call them. While both functions simply return `false` and have no side effects, the inconsistency could cause confusion and may matter if the resolver logic is extended.

**Recommendation:**
```solidity
function revoke(Attestation calldata) external payable onlyEAS returns (bool) {
    return false;
}
```

---

### [I-2] `requireSchemaMatch` and `requireTokenSafety` policy flags have no enforcement logic

**Severity:** Informational  
**Contract:** `MaiatEvaluator.sol`

**Description:**  
`EvaluationPolicy` stores two boolean flags:

```solidity
bool requireSchemaMatch;
bool requireTokenSafety;
```

These are set via `setPolicy()` and stored on-chain, but `evaluate()` never reads or enforces them. They are pure dead state.

**Impact:**  
Operators and clients reading the policy may believe these checks are active when they are not.

**Recommendation:**  
Either implement the checks or remove the flags and the corresponding `setPolicy` parameters to avoid misleading stakeholders.

---

### [I-3] `completionCount` in `MaiatHook` is global, not per-provider

**Severity:** Informational  
**Contract:** `MaiatHook.sol`

**Description:**  
`completionCount` is a single global counter incremented in `_recordCompletion()`. This provides no per-provider analytics. The comment says "actual score update would be done by Maiat backend via oracle.updateScore()" which implies the backend tracks per-provider data, but the on-chain state provides no per-address query surface.

**Recommendation:**  
Consider `mapping(address => uint256) public providerCompletions` for more useful on-chain data.

---

### [I-4] Score truncation (floor division) is undocumented and could cause unexpected boundary behavior

**Severity:** Informational  
**Contract:** `MaiatEvaluator.sol`

**Description:**  
```solidity
uint8 finalScore = uint8(weightedSum / 100);
```

This floors the result. A job with the exact weight-and-score combination that produces `5999/100 = 59` (floor) passes the `< 60` rejection path even if the "true" weighted average rounds to 60.0. This is deterministic and not exploitable, but it's an undocumented rounding decision that may surprise integrators.

For example: `providerRating=100, clientRating=59, aiScore=59`:  
`(1000 + 2360 + 2950) / 100 = 6310 / 100 = 63` ✓ (passes)

But: `providerRating=0, clientRating=59, aiScore=60`:  
`(0 + 2360 + 3000) / 100 = 5360 / 100 = 53` ✗ (correct floor)

**Recommendation:**  
Add a NatSpec comment clarifying that integer floor-division is intentional.

---

## Summary Table

| ID | Title | Severity | Status |
|----|-------|----------|--------|
| H-1 | `evaluate()` reentrancy — `record.evaluated` set after `eas.attest()` | **High** | Open |
| H-2 | No reveal deadline — evaluation can be permanently blocked | **High** | Open |
| M-1 | `aiQualityScore` defaults to 0 if `submitAIScore` never called | **Medium** | Open |
| M-2 | Mutable `oracle` in `MaiatHook` — trust gating bypassable by owner | **Medium** | Open |
| M-3 | No staleness check on oracle trust scores | **Medium** | Open |
| M-4 | Single operator — single point of failure for entire evaluation pipeline | **Medium** | Open |
| M-5 | Single-step ownership transfer — typo = permanent lockout | **Medium** | Open |
| L-1 | `evaluationSchema` not validated against `bytes32(0)` | **Low** | Open |
| L-2 | `FundingBlocked` event declared but never emitted | **Low** | Open |
| L-3 | Expired jobs orphan commit-reveal state | **Low** | Open |
| I-1 | `revoke()`/`multiRevoke()` lack `onlyEAS` modifier | **Info** | Open |
| I-2 | `requireSchemaMatch` / `requireTokenSafety` flags never enforced | **Info** | Open |
| I-3 | `completionCount` global, not per-provider | **Info** | Open |
| I-4 | Score floor truncation undocumented | **Info** | Open |

---

## Overall Assessment

**Risk Rating: MEDIUM-HIGH**

The contract system is architecturally coherent and demonstrates active security thinking (CEI attempts, custom errors, fuzz tests). However, two High findings represent real attack paths:

1. **H-2 (reveal deadline)** is the most operationally dangerous: it requires no exploit sophistication — any dissatisfied participant can freeze a job's escrow forever by simply not calling `revealReview()`. This should be fixed before mainnet deployment.

2. **H-1 (reentrancy)** is lower probability given canonical EAS, but trivially fixed by reordering two lines. No reason to leave it open.

The Medium findings collectively represent a **concentrated centralization risk**: a single compromised operator key can manipulate any evaluation, and the mutable oracle in MaiatHook means the trust-gating can be silently nullified. These are acceptable for an early-stage protocol with a known operator, but should be addressed before TVL grows or the operator role is permissionlessly assumed.

**Recommended action before mainnet:**
1. Fix H-1 (move guard flag before external calls) — 2 lines of code
2. Fix H-2 (add reveal deadline + operator force-path) — ~30 lines
3. Fix M-1 (add `aiScoreSet` flag) — ~5 lines

**Recommended before scaling:**
4. M-4: Migrate operator to a multisig
5. M-2: Make oracle immutable or add timelock
6. M-5: Switch to 2-step ownership transfer
