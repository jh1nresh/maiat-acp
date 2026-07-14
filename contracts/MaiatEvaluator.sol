// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IAgenticCommerce, IACPHook} from "./interfaces/IAgenticCommerce.sol";
import {MaiatOracle} from "./MaiatOracle.sol";

/**
 * @title MaiatEvaluator
 * @notice Evaluator contract for ACP jobs with dual-review scoring mechanism
 * @dev Integrates with MaiatOracle for trust checks and EAS for attestation receipts.
 *      Implements Airbnb-style commit-reveal dual review with AI quality scoring.
 *
 *      Review Weights:
 *        - Provider review: 10%
 *        - Client review: 40%
 *        - AI quality score: 50%
 *
 *      Threshold: score >= 60 → complete, < 60 → reject
 *
 * @custom:security-audit
 *   - Only operator can trigger final evaluate()
 *   - Commit-reveal prevents review manipulation
 *   - Trust score checked before evaluation
 *   - Payment verification via escrow check
 *   - CEI pattern throughout
 *   - Zero-address checks on all admin functions
 */

// ── EAS Interface ────────────────────────────────────────────────────────────

interface IEAS {
    struct AttestationRequestData {
        address recipient;
        uint64 expirationTime;
        bool revocable;
        bytes32 refUID;
        bytes data;
        uint256 value;
    }

    struct AttestationRequest {
        bytes32 schema;
        AttestationRequestData data;
    }

    function attest(AttestationRequest calldata request) external payable returns (bytes32);
}

contract MaiatEvaluator {
    // ── Constants ────────────────────────────────────────────────────────────

    /// @notice Maximum score value (0-100)
    uint8 public constant MAX_SCORE = 100;

    /// @notice Minimum score to approve a job
    uint8 public constant APPROVAL_THRESHOLD = 60;

    /// @notice Weight for provider review (10%)
    uint8 public constant PROVIDER_WEIGHT = 10;

    /// @notice Weight for client review (40%)
    uint8 public constant CLIENT_WEIGHT = 40;

    /// @notice Weight for AI quality score (50%)
    uint8 public constant AI_WEIGHT = 50;

    // ── Enums ────────────────────────────────────────────────────────────────

    /// @notice Review commitment state
    enum ReviewState {
        None, // No review submitted
        Committed, // Hash committed, not revealed
        Revealed // Review revealed
    }

    // ── Structs ──────────────────────────────────────────────────────────────

    /// @notice Per-job evaluation policy
    struct EvaluationPolicy {
        uint8 minTrustScore; // Minimum provider trust score required
        bool requireSchemaMatch; // Whether deliverable must match schema
        bool requireTokenSafety; // Whether token safety check is required
        bool active; // Whether policy is active
    }

    /// @notice Sealed review commitment
    struct ReviewCommitment {
        bytes32 commitHash; // keccak256(rating, reason, salt)
        ReviewState state; // Current state
        uint8 rating; // Revealed rating (0-100)
        string reason; // Revealed reason
    }

    /// @notice Complete evaluation record for a job
    struct EvaluationRecord {
        ReviewCommitment providerReview; // Provider's review of client
        ReviewCommitment clientReview; // Client's review of provider
        uint8 aiQualityScore; // AI-determined quality score
        uint8 finalScore; // Weighted average score
        bool aiScoreSubmitted; // Whether AI score was explicitly set
        bool evaluated; // Whether evaluation is complete
        bytes32 attestationUid; // EAS attestation UID for receipt
        uint64 evaluatedAt; // Timestamp of evaluation
        uint64 revealDeadline; // Deadline for reveals (set when both commit)
    }

    // ── Immutables ───────────────────────────────────────────────────────────

    /// @notice The MaiatOracle contract for trust scores
    MaiatOracle public immutable oracle;

    /// @notice The EAS contract for attestations
    IEAS public immutable eas;

    /// @notice The ACP job contract
    IAgenticCommerce public immutable acp;

    /// @notice EAS schema UID for evaluation receipts
    bytes32 public immutable evaluationSchema;

    /// @notice Reveal window duration (7 days)
    uint256 public constant REVEAL_WINDOW = 7 days;

    /// @notice Maximum acceptable trust score age
    uint256 public constant MAX_SCORE_AGE = 30 days;

    // ── State ────────────────────────────────────────────────────────────────

    /// @notice Contract owner (can update operator)
    address public owner;

    /// @notice Pending owner for 2-step transfer
    address public pendingOwner;

    /// @notice Maiat operator (can trigger evaluate)
    address public operator;

    /// @notice Job ID → Evaluation policy
    mapping(uint256 => EvaluationPolicy) public policies;

    /// @notice Job ID → Evaluation record
    mapping(uint256 => EvaluationRecord) public evaluations;

    /// @notice Default minimum trust score
    uint8 public defaultMinTrustScore;

    /// @notice Total evaluations performed
    uint256 public evaluationCount;

    // ── Events ───────────────────────────────────────────────────────────────

    event PolicySet(uint256 indexed jobId, uint8 minTrustScore, bool requireSchemaMatch, bool requireTokenSafety);
    event ReviewCommitted(uint256 indexed jobId, address indexed reviewer, bool isProvider);
    event ReviewRevealed(uint256 indexed jobId, address indexed reviewer, bool isProvider, uint8 rating);
    event AIScoreSubmitted(uint256 indexed jobId, uint8 score);
    event JobEvaluated(
        uint256 indexed jobId, uint8 finalScore, bool approved, bytes32 indexed attestationUid, uint64 evaluatedAt
    );
    event DefaultMinTrustScoreUpdated(uint8 oldScore, uint8 newScore);
    event OperatorUpdated(address indexed oldOperator, address indexed newOperator);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ── Errors ───────────────────────────────────────────────────────────────

    error NotOwner();
    error NotOperator();
    error ZeroAddress();
    error InvalidJobStatus();
    error NotJobParticipant();
    error AlreadyCommitted();
    error NotCommitted();
    error AlreadyRevealed();
    error InvalidReveal();
    error ReviewsNotComplete();
    error AIScoreNotSet();
    error AlreadyEvaluated();
    error TrustScoreTooLow(uint8 actual, uint8 required);
    error ScoreTooHigh(uint8 score, uint8 max);
    error InsufficientEscrow(uint256 actual, uint256 required);
    error PolicyNotActive();
    error ZeroSchema();
    error RevealDeadlineExpired();
    error RevealDeadlineNotExpired();
    error StaleTrustScore(uint64 updatedAt, uint256 maxAge);
    error NotPendingOwner();

    // ── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────────

    /// @notice Deploy the evaluator contract
    /// @param _oracle MaiatOracle contract address
    /// @param _eas EAS contract address
    /// @param _acp ACP job contract address
    /// @param _evaluationSchema EAS schema UID for evaluation receipts
    /// @param _operator Initial operator address
    /// @param _defaultMinTrustScore Default minimum trust score
    constructor(
        address _oracle,
        address _eas,
        address _acp,
        bytes32 _evaluationSchema,
        address _operator,
        uint8 _defaultMinTrustScore
    ) {
        if (_oracle == address(0)) revert ZeroAddress();
        if (_eas == address(0)) revert ZeroAddress();
        if (_acp == address(0)) revert ZeroAddress();
        if (_evaluationSchema == bytes32(0)) revert ZeroSchema();
        if (_operator == address(0)) revert ZeroAddress();
        if (_defaultMinTrustScore > MAX_SCORE) revert ScoreTooHigh(_defaultMinTrustScore, MAX_SCORE);

        oracle = MaiatOracle(_oracle);
        eas = IEAS(_eas);
        acp = IAgenticCommerce(_acp);
        evaluationSchema = _evaluationSchema;
        operator = _operator;
        owner = msg.sender;
        defaultMinTrustScore = _defaultMinTrustScore;
    }

    // ── Policy Management ────────────────────────────────────────────────────

    /// @notice Set evaluation policy for a job
    /// @param jobId The job ID
    /// @param minTrustScore Minimum trust score required
    /// @param requireSchemaMatch Whether deliverable must match schema
    /// @param requireTokenSafety Whether token safety check required
    function setPolicy(uint256 jobId, uint8 minTrustScore, bool requireSchemaMatch, bool requireTokenSafety)
        external
        onlyOperator
    {
        if (minTrustScore > MAX_SCORE) revert ScoreTooHigh(minTrustScore, MAX_SCORE);

        policies[jobId] = EvaluationPolicy({
            minTrustScore: minTrustScore,
            requireSchemaMatch: requireSchemaMatch,
            requireTokenSafety: requireTokenSafety,
            active: true
        });

        emit PolicySet(jobId, minTrustScore, requireSchemaMatch, requireTokenSafety);
    }

    /// @notice Get effective minimum trust score for a job
    /// @param jobId The job ID
    /// @return minScore The minimum trust score required
    function getEffectiveMinTrustScore(uint256 jobId) public view returns (uint8 minScore) {
        EvaluationPolicy memory policy = policies[jobId];
        return policy.active ? policy.minTrustScore : defaultMinTrustScore;
    }

    // ── Commit-Reveal Review System ──────────────────────────────────────────

    /// @notice Commit a sealed review hash
    /// @dev Hash = keccak256(abi.encodePacked(rating, reason, salt))
    /// @param jobId The job ID
    /// @param commitHash The sealed review hash
    function commitReview(uint256 jobId, bytes32 commitHash) external {
        IAgenticCommerce.Job memory job = acp.getJob(jobId);

        // Verify caller is participant
        bool isProvider = msg.sender == job.provider;
        bool isClient = msg.sender == job.client;
        if (!isProvider && !isClient) revert NotJobParticipant();

        // Job must be in Submitted state for reviews
        if (job.status != IAgenticCommerce.JobStatus.Submitted) revert InvalidJobStatus();

        EvaluationRecord storage record = evaluations[jobId];

        // Check not already committed
        if (isProvider) {
            if (record.providerReview.state != ReviewState.None) revert AlreadyCommitted();
            record.providerReview.commitHash = commitHash;
            record.providerReview.state = ReviewState.Committed;
        } else {
            if (record.clientReview.state != ReviewState.None) revert AlreadyCommitted();
            record.clientReview.commitHash = commitHash;
            record.clientReview.state = ReviewState.Committed;
        }

        // Set reveal deadline when both parties have committed
        if (
            record.providerReview.state != ReviewState.None && record.clientReview.state != ReviewState.None
                && record.revealDeadline == 0
        ) {
            record.revealDeadline = uint64(block.timestamp + REVEAL_WINDOW);
        }

        emit ReviewCommitted(jobId, msg.sender, isProvider);
    }

    /// @notice Reveal a previously committed review
    /// @param jobId The job ID
    /// @param rating The rating (0-100)
    /// @param reason The review reason
    /// @param salt The salt used in commitment
    function revealReview(uint256 jobId, uint8 rating, string calldata reason, bytes32 salt) external {
        if (rating > MAX_SCORE) revert ScoreTooHigh(rating, MAX_SCORE);

        IAgenticCommerce.Job memory job = acp.getJob(jobId);

        bool isProvider = msg.sender == job.provider;
        bool isClient = msg.sender == job.client;
        if (!isProvider && !isClient) revert NotJobParticipant();

        EvaluationRecord storage record = evaluations[jobId];

        // Both parties must have committed before either can reveal
        if (record.providerReview.state == ReviewState.None) revert NotCommitted();
        if (record.clientReview.state == ReviewState.None) revert NotCommitted();

        // Check reveal deadline hasn't expired
        if (record.revealDeadline > 0 && block.timestamp > record.revealDeadline) {
            revert RevealDeadlineExpired();
        }

        // Get the appropriate review commitment
        ReviewCommitment storage review = isProvider ? record.providerReview : record.clientReview;

        if (review.state == ReviewState.None) revert NotCommitted();
        if (review.state == ReviewState.Revealed) revert AlreadyRevealed();

        // Verify the reveal matches the commitment
        bytes32 expectedHash = keccak256(abi.encodePacked(rating, reason, salt));
        if (expectedHash != review.commitHash) revert InvalidReveal();

        // Store revealed values
        review.rating = rating;
        review.reason = reason;
        review.state = ReviewState.Revealed;

        emit ReviewRevealed(jobId, msg.sender, isProvider, rating);
    }

    /// @notice Submit AI quality score (operator only)
    /// @param jobId The job ID
    /// @param score The AI-determined quality score (0-100)
    function submitAIScore(uint256 jobId, uint8 score) external onlyOperator {
        if (score > MAX_SCORE) revert ScoreTooHigh(score, MAX_SCORE);

        EvaluationRecord storage record = evaluations[jobId];
        if (record.evaluated) revert AlreadyEvaluated();

        record.aiQualityScore = score;
        record.aiScoreSubmitted = true;

        emit AIScoreSubmitted(jobId, score);
    }

    // ── Evaluation ───────────────────────────────────────────────────────────

    /// @notice Execute final evaluation for a job
    /// @dev Only operator can call. Checks trust score, reviews, and escrow.
    /// @param jobId The job ID to evaluate
    function evaluate(uint256 jobId) external onlyOperator {
        EvaluationRecord storage record = evaluations[jobId];

        // Check not already evaluated — set guard FIRST (H-1: reentrancy fix)
        if (record.evaluated) revert AlreadyEvaluated();
        record.evaluated = true;

        IAgenticCommerce.Job memory job = acp.getJob(jobId);

        // Job must be in Submitted state
        if (job.status != IAgenticCommerce.JobStatus.Submitted) revert InvalidJobStatus();

        // Check both reviews are revealed
        if (record.providerReview.state != ReviewState.Revealed) revert ReviewsNotComplete();
        if (record.clientReview.state != ReviewState.Revealed) revert ReviewsNotComplete();

        // H-3: Check AI score was explicitly set
        if (!record.aiScoreSubmitted) revert AIScoreNotSet();

        // Check provider trust score with staleness check (M-3)
        uint8 minTrust = getEffectiveMinTrustScore(jobId);
        (uint8 trustScore,, uint64 updatedAt) = oracle.getTrustScore(job.provider);
        if (trustScore < minTrust) revert TrustScoreTooLow(trustScore, minTrust);
        if (updatedAt > 0 && block.timestamp - updatedAt > MAX_SCORE_AGE) {
            revert StaleTrustScore(updatedAt, MAX_SCORE_AGE);
        }

        // Verify escrow is funded
        uint256 escrowBalance = acp.getEscrowBalance(jobId);
        if (escrowBalance < job.budget) revert InsufficientEscrow(escrowBalance, job.budget);

        // Calculate weighted average score
        uint256 weightedSum = (uint256(record.providerReview.rating) * PROVIDER_WEIGHT)
            + (uint256(record.clientReview.rating) * CLIENT_WEIGHT) + (uint256(record.aiQualityScore) * AI_WEIGHT);

        uint8 finalScore = uint8(weightedSum / 100);

        // Effects — update record before external calls
        record.finalScore = finalScore;
        record.evaluatedAt = uint64(block.timestamp);
        evaluationCount++;

        // Interactions — all external calls AFTER state changes (CEI pattern)
        bytes32 attestationUid = _issueAttestation(jobId, job, finalScore, finalScore >= APPROVAL_THRESHOLD);
        record.attestationUid = attestationUid;

        emit JobEvaluated(jobId, finalScore, finalScore >= APPROVAL_THRESHOLD, attestationUid, record.evaluatedAt);

        // Call ACP to complete or reject
        if (finalScore >= APPROVAL_THRESHOLD) {
            acp.complete(jobId, _buildCompletionReason(finalScore), "");
        } else {
            acp.reject(jobId, _buildRejectionReason(finalScore), "");
        }
    }

    /// @notice Force evaluate a job after reveal deadline expires (H-2: reveal-withholding fix)
    /// @dev Uses only available reviews, treating missing reveals as 0 score
    /// @param jobId The job ID
    function forceEvaluateAfterDeadline(uint256 jobId) external onlyOperator {
        EvaluationRecord storage record = evaluations[jobId];

        if (record.evaluated) revert AlreadyEvaluated();
        if (record.revealDeadline == 0) revert NotCommitted();
        if (block.timestamp <= record.revealDeadline) revert RevealDeadlineNotExpired();

        record.evaluated = true;

        IAgenticCommerce.Job memory job = acp.getJob(jobId);
        if (job.status != IAgenticCommerce.JobStatus.Submitted) revert InvalidJobStatus();

        // Use revealed scores, default 0 for unrevealed
        uint8 providerRating = record.providerReview.state == ReviewState.Revealed ? record.providerReview.rating : 0;
        uint8 clientRating = record.clientReview.state == ReviewState.Revealed ? record.clientReview.rating : 0;
        uint8 aiScore = record.aiScoreSubmitted ? record.aiQualityScore : 0;

        uint256 weightedSum =
            (uint256(providerRating) * PROVIDER_WEIGHT) + (uint256(clientRating) * CLIENT_WEIGHT) + (uint256(aiScore) * AI_WEIGHT);

        uint8 finalScore = uint8(weightedSum / 100);

        record.finalScore = finalScore;
        record.evaluatedAt = uint64(block.timestamp);
        evaluationCount++;

        bytes32 attestationUid = _issueAttestation(jobId, job, finalScore, finalScore >= APPROVAL_THRESHOLD);
        record.attestationUid = attestationUid;

        emit JobEvaluated(jobId, finalScore, finalScore >= APPROVAL_THRESHOLD, attestationUid, record.evaluatedAt);

        if (finalScore >= APPROVAL_THRESHOLD) {
            acp.complete(jobId, _buildCompletionReason(finalScore), "");
        } else {
            acp.reject(jobId, _buildRejectionReason(finalScore), "");
        }
    }

    /// @notice Build completion reason string
    function _buildCompletionReason(uint8 score) internal pure returns (string memory) {
        return string(abi.encodePacked("Evaluation passed with score: ", _uint8ToString(score)));
    }

    /// @notice Build rejection reason string
    function _buildRejectionReason(uint8 score) internal pure returns (string memory) {
        return string(abi.encodePacked("Evaluation failed with score: ", _uint8ToString(score)));
    }

    /// @notice Convert uint8 to string
    function _uint8ToString(uint8 value) internal pure returns (string memory) {
        if (value == 0) return "0";

        uint8 temp = value;
        uint8 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }

        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint8(value % 10)));
            value /= 10;
        }

        return string(buffer);
    }

    /// @notice Issue EAS attestation for evaluation
    function _issueAttestation(uint256 jobId, IAgenticCommerce.Job memory job, uint8 score, bool approved)
        internal
        returns (bytes32)
    {
        bytes memory data = abi.encode(jobId, job.client, job.provider, score, approved, block.timestamp);

        IEAS.AttestationRequest memory request = IEAS.AttestationRequest({
            schema: evaluationSchema,
            data: IEAS.AttestationRequestData({
                recipient: job.provider,
                expirationTime: 0,
                revocable: false,
                refUID: bytes32(0),
                data: data,
                value: 0
            })
        });

        return eas.attest(request);
    }

    // ── View Functions ───────────────────────────────────────────────────────

    /// @notice Get evaluation record for a job
    /// @param jobId The job ID
    /// @return record The evaluation record
    function getEvaluation(uint256 jobId) external view returns (EvaluationRecord memory record) {
        return evaluations[jobId];
    }

    /// @notice Check if both reviews are committed
    /// @param jobId The job ID
    /// @return bothCommitted True if both parties have committed
    function areBothReviewsCommitted(uint256 jobId) external view returns (bool bothCommitted) {
        EvaluationRecord memory record = evaluations[jobId];
        return record.providerReview.state != ReviewState.None && record.clientReview.state != ReviewState.None;
    }

    /// @notice Check if both reviews are revealed
    /// @param jobId The job ID
    /// @return bothRevealed True if both parties have revealed
    function areBothReviewsRevealed(uint256 jobId) external view returns (bool bothRevealed) {
        EvaluationRecord memory record = evaluations[jobId];
        return record.providerReview.state == ReviewState.Revealed
            && record.clientReview.state == ReviewState.Revealed;
    }

    /// @notice Check if a job is ready for evaluation
    /// @param jobId The job ID
    /// @return ready True if ready for evaluate() call
    function isReadyForEvaluation(uint256 jobId) external view returns (bool ready) {
        EvaluationRecord memory record = evaluations[jobId];
        IAgenticCommerce.Job memory job = acp.getJob(jobId);

        return !record.evaluated && job.status == IAgenticCommerce.JobStatus.Submitted
            && record.providerReview.state == ReviewState.Revealed
            && record.clientReview.state == ReviewState.Revealed;
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    /// @notice Update the default minimum trust score
    /// @param _newScore The new default minimum score
    function setDefaultMinTrustScore(uint8 _newScore) external onlyOwner {
        if (_newScore > MAX_SCORE) revert ScoreTooHigh(_newScore, MAX_SCORE);

        emit DefaultMinTrustScoreUpdated(defaultMinTrustScore, _newScore);
        defaultMinTrustScore = _newScore;
    }

    /// @notice Update the operator address
    /// @param _newOperator The new operator address
    function setOperator(address _newOperator) external onlyOwner {
        if (_newOperator == address(0)) revert ZeroAddress();

        emit OperatorUpdated(operator, _newOperator);
        operator = _newOperator;
    }

    /// @notice Initiate 2-step ownership transfer (M-5)
    /// @param _newOwner The new pending owner address
    function transferOwnership(address _newOwner) external onlyOwner {
        if (_newOwner == address(0)) revert ZeroAddress();
        pendingOwner = _newOwner;
    }

    /// @notice Accept ownership transfer (2-step)
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }
}
