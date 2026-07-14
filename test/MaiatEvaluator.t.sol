// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../contracts/MaiatEvaluator.sol";
import "../contracts/MaiatOracle.sol";
import "../contracts/interfaces/IAgenticCommerce.sol";

/// @dev Mock EAS contract for testing
contract MockEAS {
    uint256 private _attestationCounter;

    function attest(IEAS.AttestationRequest calldata) external payable returns (bytes32) {
        _attestationCounter++;
        return bytes32(_attestationCounter);
    }
}

/// @dev Mock ACP contract for testing
contract MockACP is IAgenticCommerce {
    mapping(uint256 => Job) private _jobs;
    mapping(uint256 => uint256) private _escrows;
    uint256 public lastCompletedJobId;
    uint256 public lastRejectedJobId;
    string public lastCompletionReason;
    string public lastRejectionReason;

    function setJob(uint256 jobId, Job memory job) external {
        _jobs[jobId] = job;
    }

    function setEscrow(uint256 jobId, uint256 amount) external {
        _escrows[jobId] = amount;
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }

    function complete(uint256 jobId, string calldata reason, bytes calldata) external {
        lastCompletedJobId = jobId;
        lastCompletionReason = reason;
        _jobs[jobId].status = JobStatus.Completed;
    }

    function reject(uint256 jobId, string calldata reason, bytes calldata) external {
        lastRejectedJobId = jobId;
        lastRejectionReason = reason;
        _jobs[jobId].status = JobStatus.Rejected;
    }

    function getEscrowBalance(uint256 jobId) external view returns (uint256) {
        return _escrows[jobId];
    }
}

contract MaiatEvaluatorTest is Test {
    MaiatEvaluator evaluator;
    MaiatOracle oracle;
    MockEAS mockEAS;
    MockACP mockACP;

    address owner = address(this);
    address operator = address(0xBEEF);
    address client = address(0x1111);
    address provider = address(0x2222);
    address nonParticipant = address(0xDEAD);

    bytes32 constant EVALUATION_SCHEMA = bytes32(uint256(1));
    uint8 constant DEFAULT_MIN_TRUST = 50;
    uint256 constant JOB_ID = 1;
    uint256 constant JOB_BUDGET = 1 ether;

    event PolicySet(uint256 indexed jobId, uint8 minTrustScore, bool requireSchemaMatch, bool requireTokenSafety);
    event ReviewCommitted(uint256 indexed jobId, address indexed reviewer, bool isProvider);
    event ReviewRevealed(uint256 indexed jobId, address indexed reviewer, bool isProvider, uint8 rating);
    event AIScoreSubmitted(uint256 indexed jobId, uint8 score);
    event JobEvaluated(
        uint256 indexed jobId, uint8 finalScore, bool approved, bytes32 indexed attestationUid, uint64 evaluatedAt
    );
    event OperatorUpdated(address indexed oldOperator, address indexed newOperator);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    function setUp() public {
        oracle = new MaiatOracle(operator);
        mockEAS = new MockEAS();
        mockACP = new MockACP();

        evaluator = new MaiatEvaluator(
            address(oracle), address(mockEAS), address(mockACP), EVALUATION_SCHEMA, operator, DEFAULT_MIN_TRUST
        );

        // Set up provider trust score
        vm.prank(operator);
        oracle.updateScore(provider, 80, "proceed", 1, "agent_trust");

        // Create a test job in Submitted state
        _createSubmittedJob(JOB_ID);
    }

    function _createSubmittedJob(uint256 jobId) internal {
        IAgenticCommerce.Job memory job = IAgenticCommerce.Job({
            client: client,
            provider: provider,
            evaluator: address(evaluator),
            budget: JOB_BUDGET,
            expiredAt: uint64(block.timestamp + 1 days),
            status: IAgenticCommerce.JobStatus.Submitted,
            hook: address(0),
            description: "Test job"
        });
        mockACP.setJob(jobId, job);
        mockACP.setEscrow(jobId, JOB_BUDGET);
    }

    // ── Constructor ───────────────────────────────────────────────────────

    function test_constructor_setsCorrectValues() public view {
        assertEq(address(evaluator.oracle()), address(oracle));
        assertEq(address(evaluator.eas()), address(mockEAS));
        assertEq(address(evaluator.acp()), address(mockACP));
        assertEq(evaluator.evaluationSchema(), EVALUATION_SCHEMA);
        assertEq(evaluator.operator(), operator);
        assertEq(evaluator.owner(), owner);
        assertEq(evaluator.defaultMinTrustScore(), DEFAULT_MIN_TRUST);
    }

    function test_constructor_revertsOnZeroOracle() public {
        vm.expectRevert(MaiatEvaluator.ZeroAddress.selector);
        new MaiatEvaluator(address(0), address(mockEAS), address(mockACP), EVALUATION_SCHEMA, operator, DEFAULT_MIN_TRUST);
    }

    function test_constructor_revertsOnZeroEAS() public {
        vm.expectRevert(MaiatEvaluator.ZeroAddress.selector);
        new MaiatEvaluator(address(oracle), address(0), address(mockACP), EVALUATION_SCHEMA, operator, DEFAULT_MIN_TRUST);
    }

    function test_constructor_revertsOnZeroACP() public {
        vm.expectRevert(MaiatEvaluator.ZeroAddress.selector);
        new MaiatEvaluator(address(oracle), address(mockEAS), address(0), EVALUATION_SCHEMA, operator, DEFAULT_MIN_TRUST);
    }

    function test_constructor_revertsOnZeroOperator() public {
        vm.expectRevert(MaiatEvaluator.ZeroAddress.selector);
        new MaiatEvaluator(
            address(oracle), address(mockEAS), address(mockACP), EVALUATION_SCHEMA, address(0), DEFAULT_MIN_TRUST
        );
    }

    function test_constructor_revertsOnScoreTooHigh() public {
        vm.expectRevert(abi.encodeWithSelector(MaiatEvaluator.ScoreTooHigh.selector, 101, 100));
        new MaiatEvaluator(address(oracle), address(mockEAS), address(mockACP), EVALUATION_SCHEMA, operator, 101);
    }

    // ── Policy Management ─────────────────────────────────────────────────

    function test_setPolicy_success() public {
        vm.expectEmit(true, false, false, true);
        emit PolicySet(JOB_ID, 70, true, true);

        vm.prank(operator);
        evaluator.setPolicy(JOB_ID, 70, true, true);

        (uint8 minTrust, bool schemaMatch, bool tokenSafety, bool active) = evaluator.policies(JOB_ID);
        assertEq(minTrust, 70);
        assertTrue(schemaMatch);
        assertTrue(tokenSafety);
        assertTrue(active);
    }

    function test_setPolicy_revertsOnNonOperator() public {
        vm.prank(nonParticipant);
        vm.expectRevert(MaiatEvaluator.NotOperator.selector);
        evaluator.setPolicy(JOB_ID, 70, true, true);
    }

    function test_setPolicy_revertsOnScoreTooHigh() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(MaiatEvaluator.ScoreTooHigh.selector, 101, 100));
        evaluator.setPolicy(JOB_ID, 101, true, true);
    }

    function test_getEffectiveMinTrustScore_returnsDefault() public view {
        assertEq(evaluator.getEffectiveMinTrustScore(JOB_ID), DEFAULT_MIN_TRUST);
    }

    function test_getEffectiveMinTrustScore_returnsOverride() public {
        vm.prank(operator);
        evaluator.setPolicy(JOB_ID, 90, false, false);
        assertEq(evaluator.getEffectiveMinTrustScore(JOB_ID), 90);
    }

    // ── Commit-Reveal Review System ───────────────────────────────────────

    function test_commitReview_providerSuccess() public {
        bytes32 commitHash = keccak256(abi.encodePacked(uint8(80), "Great client", bytes32(uint256(12345))));

        vm.expectEmit(true, true, false, true);
        emit ReviewCommitted(JOB_ID, provider, true);

        vm.prank(provider);
        evaluator.commitReview(JOB_ID, commitHash);

        MaiatEvaluator.EvaluationRecord memory record = evaluator.getEvaluation(JOB_ID);
        assertEq(uint8(record.providerReview.state), uint8(MaiatEvaluator.ReviewState.Committed));
        assertEq(record.providerReview.commitHash, commitHash);
    }

    function test_commitReview_clientSuccess() public {
        bytes32 commitHash = keccak256(abi.encodePacked(uint8(90), "Excellent work", bytes32(uint256(67890))));

        vm.expectEmit(true, true, false, true);
        emit ReviewCommitted(JOB_ID, client, false);

        vm.prank(client);
        evaluator.commitReview(JOB_ID, commitHash);

        MaiatEvaluator.EvaluationRecord memory record = evaluator.getEvaluation(JOB_ID);
        assertEq(uint8(record.clientReview.state), uint8(MaiatEvaluator.ReviewState.Committed));
    }

    function test_commitReview_revertsOnNonParticipant() public {
        bytes32 commitHash = keccak256(abi.encodePacked(uint8(50), "test", bytes32(uint256(1))));

        vm.prank(nonParticipant);
        vm.expectRevert(MaiatEvaluator.NotJobParticipant.selector);
        evaluator.commitReview(JOB_ID, commitHash);
    }

    function test_commitReview_revertsOnInvalidStatus() public {
        // Change job to Funded (not Submitted)
        IAgenticCommerce.Job memory job = mockACP.getJob(JOB_ID);
        job.status = IAgenticCommerce.JobStatus.Funded;
        mockACP.setJob(JOB_ID, job);

        bytes32 commitHash = keccak256(abi.encodePacked(uint8(50), "test", bytes32(uint256(1))));

        vm.prank(provider);
        vm.expectRevert(MaiatEvaluator.InvalidJobStatus.selector);
        evaluator.commitReview(JOB_ID, commitHash);
    }

    function test_commitReview_revertsOnAlreadyCommitted() public {
        bytes32 commitHash = keccak256(abi.encodePacked(uint8(80), "test", bytes32(uint256(1))));

        vm.prank(provider);
        evaluator.commitReview(JOB_ID, commitHash);

        vm.prank(provider);
        vm.expectRevert(MaiatEvaluator.AlreadyCommitted.selector);
        evaluator.commitReview(JOB_ID, commitHash);
    }

    function test_revealReview_success() public {
        // Both parties commit
        bytes32 providerSalt = bytes32(uint256(111));
        bytes32 clientSalt = bytes32(uint256(222));
        uint8 providerRating = 75;
        uint8 clientRating = 85;
        string memory providerReason = "Good client";
        string memory clientReason = "Good provider";

        bytes32 providerCommit = keccak256(abi.encodePacked(providerRating, providerReason, providerSalt));
        bytes32 clientCommit = keccak256(abi.encodePacked(clientRating, clientReason, clientSalt));

        vm.prank(provider);
        evaluator.commitReview(JOB_ID, providerCommit);

        vm.prank(client);
        evaluator.commitReview(JOB_ID, clientCommit);

        // Provider reveals
        vm.expectEmit(true, true, false, true);
        emit ReviewRevealed(JOB_ID, provider, true, providerRating);

        vm.prank(provider);
        evaluator.revealReview(JOB_ID, providerRating, providerReason, providerSalt);

        MaiatEvaluator.EvaluationRecord memory record = evaluator.getEvaluation(JOB_ID);
        assertEq(uint8(record.providerReview.state), uint8(MaiatEvaluator.ReviewState.Revealed));
        assertEq(record.providerReview.rating, providerRating);

        // Client reveals
        vm.prank(client);
        evaluator.revealReview(JOB_ID, clientRating, clientReason, clientSalt);

        record = evaluator.getEvaluation(JOB_ID);
        assertEq(uint8(record.clientReview.state), uint8(MaiatEvaluator.ReviewState.Revealed));
        assertEq(record.clientReview.rating, clientRating);
    }

    function test_revealReview_revertsOnNotCommitted() public {
        vm.prank(provider);
        vm.expectRevert(MaiatEvaluator.NotCommitted.selector);
        evaluator.revealReview(JOB_ID, 80, "test", bytes32(uint256(1)));
    }

    function test_revealReview_revertsWhenOtherPartyNotCommitted() public {
        // Only provider commits
        bytes32 providerCommit = keccak256(abi.encodePacked(uint8(80), "test", bytes32(uint256(1))));
        vm.prank(provider);
        evaluator.commitReview(JOB_ID, providerCommit);

        // Provider tries to reveal before client commits
        vm.prank(provider);
        vm.expectRevert(MaiatEvaluator.NotCommitted.selector);
        evaluator.revealReview(JOB_ID, 80, "test", bytes32(uint256(1)));
    }

    function test_revealReview_revertsOnInvalidReveal() public {
        _commitBothReviews();

        // Provider tries to reveal with wrong data
        vm.prank(provider);
        vm.expectRevert(MaiatEvaluator.InvalidReveal.selector);
        evaluator.revealReview(JOB_ID, 99, "wrong", bytes32(uint256(999)));
    }

    function test_revealReview_revertsOnScoreTooHigh() public {
        _commitBothReviews();

        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(MaiatEvaluator.ScoreTooHigh.selector, 101, 100));
        evaluator.revealReview(JOB_ID, 101, "test", bytes32(uint256(1)));
    }

    function test_revealReview_revertsOnAlreadyRevealed() public {
        _commitBothReviews();
        _revealBothReviews();

        // Try to reveal again
        vm.prank(provider);
        vm.expectRevert(MaiatEvaluator.AlreadyRevealed.selector);
        evaluator.revealReview(JOB_ID, 80, "Good client", bytes32(uint256(111)));
    }

    // ── AI Score Submission ───────────────────────────────────────────────

    function test_submitAIScore_success() public {
        vm.expectEmit(true, false, false, true);
        emit AIScoreSubmitted(JOB_ID, 75);

        vm.prank(operator);
        evaluator.submitAIScore(JOB_ID, 75);

        MaiatEvaluator.EvaluationRecord memory record = evaluator.getEvaluation(JOB_ID);
        assertEq(record.aiQualityScore, 75);
    }

    function test_submitAIScore_revertsOnNonOperator() public {
        vm.prank(nonParticipant);
        vm.expectRevert(MaiatEvaluator.NotOperator.selector);
        evaluator.submitAIScore(JOB_ID, 75);
    }

    function test_submitAIScore_revertsOnScoreTooHigh() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(MaiatEvaluator.ScoreTooHigh.selector, 101, 100));
        evaluator.submitAIScore(JOB_ID, 101);
    }

    // ── Evaluate ──────────────────────────────────────────────────────────

    function test_evaluate_completesOnHighScore() public {
        _commitBothReviews();
        _revealBothReviews();

        vm.prank(operator);
        evaluator.submitAIScore(JOB_ID, 70);

        // Expected: (80*10 + 85*40 + 70*50) / 100 = (800 + 3400 + 3500) / 100 = 77
        vm.prank(operator);
        evaluator.evaluate(JOB_ID);

        MaiatEvaluator.EvaluationRecord memory record = evaluator.getEvaluation(JOB_ID);
        assertTrue(record.evaluated);
        assertEq(record.finalScore, 77);
        assertTrue(record.attestationUid != bytes32(0));
        assertEq(mockACP.lastCompletedJobId(), JOB_ID);
        assertEq(evaluator.evaluationCount(), 1);
    }

    function test_evaluate_rejectsOnLowScore() public {
        _commitBothReviews();
        _revealBothReviews();

        vm.prank(operator);
        evaluator.submitAIScore(JOB_ID, 20);

        // Expected: (80*10 + 85*40 + 20*50) / 100 = (800 + 3400 + 1000) / 100 = 52
        vm.prank(operator);
        evaluator.evaluate(JOB_ID);

        MaiatEvaluator.EvaluationRecord memory record = evaluator.getEvaluation(JOB_ID);
        assertTrue(record.evaluated);
        assertEq(record.finalScore, 52);
        assertEq(mockACP.lastRejectedJobId(), JOB_ID);
    }

    function test_evaluate_revertsOnLowTrustScore() public {
        // Set provider trust to low score
        vm.prank(operator);
        oracle.updateScore(provider, 30, "caution", 2, "agent_trust");

        _commitBothReviews();
        _revealBothReviews();

        vm.prank(operator);
        evaluator.submitAIScore(JOB_ID, 70);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(MaiatEvaluator.TrustScoreTooLow.selector, 30, DEFAULT_MIN_TRUST));
        evaluator.evaluate(JOB_ID);
    }

    function test_evaluate_revertsOnInsufficientEscrow() public {
        _commitBothReviews();
        _revealBothReviews();

        vm.prank(operator);
        evaluator.submitAIScore(JOB_ID, 70);

        // Reduce escrow below budget
        mockACP.setEscrow(JOB_ID, JOB_BUDGET / 2);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(MaiatEvaluator.InsufficientEscrow.selector, JOB_BUDGET / 2, JOB_BUDGET));
        evaluator.evaluate(JOB_ID);
    }

    function test_evaluate_revertsOnNotOperator() public {
        _commitBothReviews();
        _revealBothReviews();

        vm.prank(operator);
        evaluator.submitAIScore(JOB_ID, 70);

        vm.prank(nonParticipant);
        vm.expectRevert(MaiatEvaluator.NotOperator.selector);
        evaluator.evaluate(JOB_ID);
    }

    function test_evaluate_revertsOnAlreadyEvaluated() public {
        _commitBothReviews();
        _revealBothReviews();

        vm.prank(operator);
        evaluator.submitAIScore(JOB_ID, 70);

        vm.prank(operator);
        evaluator.evaluate(JOB_ID);

        vm.prank(operator);
        vm.expectRevert(MaiatEvaluator.AlreadyEvaluated.selector);
        evaluator.evaluate(JOB_ID);
    }

    function test_evaluate_revertsOnReviewsNotComplete() public {
        _commitBothReviews();
        // Don't reveal

        vm.prank(operator);
        evaluator.submitAIScore(JOB_ID, 70);

        vm.prank(operator);
        vm.expectRevert(MaiatEvaluator.ReviewsNotComplete.selector);
        evaluator.evaluate(JOB_ID);
    }

    function test_evaluate_revertsOnInvalidJobStatus() public {
        _commitBothReviews();
        _revealBothReviews();

        vm.prank(operator);
        evaluator.submitAIScore(JOB_ID, 70);

        // Change job to Funded (not Submitted)
        IAgenticCommerce.Job memory job = mockACP.getJob(JOB_ID);
        job.status = IAgenticCommerce.JobStatus.Funded;
        mockACP.setJob(JOB_ID, job);

        vm.prank(operator);
        vm.expectRevert(MaiatEvaluator.InvalidJobStatus.selector);
        evaluator.evaluate(JOB_ID);
    }

    // ── View Functions ────────────────────────────────────────────────────

    function test_areBothReviewsCommitted() public {
        assertFalse(evaluator.areBothReviewsCommitted(JOB_ID));

        _commitBothReviews();
        assertTrue(evaluator.areBothReviewsCommitted(JOB_ID));
    }

    function test_areBothReviewsRevealed() public {
        assertFalse(evaluator.areBothReviewsRevealed(JOB_ID));

        _commitBothReviews();
        assertFalse(evaluator.areBothReviewsRevealed(JOB_ID));

        _revealBothReviews();
        assertTrue(evaluator.areBothReviewsRevealed(JOB_ID));
    }

    function test_isReadyForEvaluation() public {
        assertFalse(evaluator.isReadyForEvaluation(JOB_ID));

        _commitBothReviews();
        _revealBothReviews();

        assertTrue(evaluator.isReadyForEvaluation(JOB_ID));
    }

    // ── Admin ─────────────────────────────────────────────────────────────

    function test_setDefaultMinTrustScore_success() public {
        evaluator.setDefaultMinTrustScore(75);
        assertEq(evaluator.defaultMinTrustScore(), 75);
    }

    function test_setDefaultMinTrustScore_revertsOnNonOwner() public {
        vm.prank(nonParticipant);
        vm.expectRevert(MaiatEvaluator.NotOwner.selector);
        evaluator.setDefaultMinTrustScore(75);
    }

    function test_setOperator_success() public {
        address newOp = address(0xCAFE);

        vm.expectEmit(true, true, false, false);
        emit OperatorUpdated(operator, newOp);

        evaluator.setOperator(newOp);
        assertEq(evaluator.operator(), newOp);
    }

    function test_setOperator_revertsOnZeroAddress() public {
        vm.expectRevert(MaiatEvaluator.ZeroAddress.selector);
        evaluator.setOperator(address(0));
    }

    function test_transferOwnership_success() public {
        address newOwner = address(0xCAFE);

        // Step 1: initiate transfer (no event yet)
        evaluator.transferOwnership(newOwner);
        assertEq(evaluator.pendingOwner(), newOwner);
        assertEq(evaluator.owner(), owner); // still old owner

        // Step 2: accept ownership
        vm.expectEmit(true, true, false, false);
        emit OwnershipTransferred(owner, newOwner);

        vm.prank(newOwner);
        evaluator.acceptOwnership();
        assertEq(evaluator.owner(), newOwner);
        assertEq(evaluator.pendingOwner(), address(0));
    }

    // ── Fuzz Tests ────────────────────────────────────────────────────────

    function testFuzz_setPolicy_scoreBounds(uint8 score) public {
        if (score > 100) {
            vm.prank(operator);
            vm.expectRevert(abi.encodeWithSelector(MaiatEvaluator.ScoreTooHigh.selector, score, 100));
            evaluator.setPolicy(JOB_ID, score, false, false);
        } else {
            vm.prank(operator);
            evaluator.setPolicy(JOB_ID, score, false, false);
            assertEq(evaluator.getEffectiveMinTrustScore(JOB_ID), score);
        }
    }

    function testFuzz_submitAIScore_bounds(uint8 score) public {
        if (score > 100) {
            vm.prank(operator);
            vm.expectRevert(abi.encodeWithSelector(MaiatEvaluator.ScoreTooHigh.selector, score, 100));
            evaluator.submitAIScore(JOB_ID, score);
        } else {
            vm.prank(operator);
            evaluator.submitAIScore(JOB_ID, score);
            MaiatEvaluator.EvaluationRecord memory record = evaluator.getEvaluation(JOB_ID);
            assertEq(record.aiQualityScore, score);
        }
    }

    function testFuzz_commitReview_onlyParticipants(address caller) public {
        vm.assume(caller != provider && caller != client);

        bytes32 commitHash = keccak256(abi.encodePacked(uint8(50), "test", bytes32(uint256(1))));

        vm.prank(caller);
        vm.expectRevert(MaiatEvaluator.NotJobParticipant.selector);
        evaluator.commitReview(JOB_ID, commitHash);
    }

    function testFuzz_evaluate_onlyOperator(address caller) public {
        vm.assume(caller != operator);

        _commitBothReviews();
        _revealBothReviews();

        vm.prank(operator);
        evaluator.submitAIScore(JOB_ID, 70);

        vm.prank(caller);
        vm.expectRevert(MaiatEvaluator.NotOperator.selector);
        evaluator.evaluate(JOB_ID);
    }

    function testFuzz_scoreCalculation(uint8 providerRating, uint8 clientRating, uint8 aiScore) public {
        vm.assume(providerRating <= 100);
        vm.assume(clientRating <= 100);
        vm.assume(aiScore <= 100);

        // Set up fresh job
        uint256 freshJobId = 999;
        _createSubmittedJob(freshJobId);

        // Commit and reveal with the fuzzed values
        bytes32 providerSalt = bytes32(uint256(111));
        bytes32 clientSalt = bytes32(uint256(222));
        string memory providerReason = "reason";
        string memory clientReason = "reason";

        bytes32 providerCommit = keccak256(abi.encodePacked(providerRating, providerReason, providerSalt));
        bytes32 clientCommit = keccak256(abi.encodePacked(clientRating, clientReason, clientSalt));

        vm.prank(provider);
        evaluator.commitReview(freshJobId, providerCommit);

        vm.prank(client);
        evaluator.commitReview(freshJobId, clientCommit);

        vm.prank(provider);
        evaluator.revealReview(freshJobId, providerRating, providerReason, providerSalt);

        vm.prank(client);
        evaluator.revealReview(freshJobId, clientRating, clientReason, clientSalt);

        vm.prank(operator);
        evaluator.submitAIScore(freshJobId, aiScore);

        vm.prank(operator);
        evaluator.evaluate(freshJobId);

        MaiatEvaluator.EvaluationRecord memory record = evaluator.getEvaluation(freshJobId);

        // Verify score calculation
        uint256 expectedScore =
            (uint256(providerRating) * 10 + uint256(clientRating) * 40 + uint256(aiScore) * 50) / 100;
        assertEq(record.finalScore, uint8(expectedScore));
    }

    // ── Helper Functions ──────────────────────────────────────────────────

    function _commitBothReviews() internal {
        bytes32 providerSalt = bytes32(uint256(111));
        bytes32 clientSalt = bytes32(uint256(222));

        bytes32 providerCommit = keccak256(abi.encodePacked(uint8(80), "Good client", providerSalt));
        bytes32 clientCommit = keccak256(abi.encodePacked(uint8(85), "Good provider", clientSalt));

        vm.prank(provider);
        evaluator.commitReview(JOB_ID, providerCommit);

        vm.prank(client);
        evaluator.commitReview(JOB_ID, clientCommit);
    }

    function _revealBothReviews() internal {
        vm.prank(provider);
        evaluator.revealReview(JOB_ID, 80, "Good client", bytes32(uint256(111)));

        vm.prank(client);
        evaluator.revealReview(JOB_ID, 85, "Good provider", bytes32(uint256(222)));
    }
}
