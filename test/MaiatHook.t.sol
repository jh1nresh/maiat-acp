// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../contracts/MaiatHook.sol";
import "../contracts/MaiatOracle.sol";
import "../contracts/interfaces/IAgenticCommerce.sol";

/// @dev Mock ACP contract for testing
contract MockACPForHook is IAgenticCommerce {
    mapping(uint256 => Job) private _jobs;
    mapping(uint256 => uint256) private _escrows;
    MaiatHook public hook;

    function setHook(address _hook) external {
        hook = MaiatHook(_hook);
    }

    function setJob(uint256 jobId, Job memory job) external {
        _jobs[jobId] = job;
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }

    function complete(uint256 jobId, string calldata, bytes calldata) external {
        // Simulate hook call
        if (address(hook) != address(0)) {
            hook.afterAction(jobId, MaiatHook(hook).COMPLETE_SELECTOR(), "");
        }
        _jobs[jobId].status = JobStatus.Completed;
    }

    function reject(uint256, string calldata, bytes calldata) external pure {
        // No hook call on reject
    }

    function getEscrowBalance(uint256 jobId) external view returns (uint256) {
        return _escrows[jobId];
    }

    // Simulate funding with hook check
    function fund(uint256 jobId, uint256, bytes calldata) external {
        // Simulate beforeAction hook call
        if (address(hook) != address(0)) {
            hook.beforeAction(jobId, MaiatHook(hook).FUND_SELECTOR(), "");
        }
        _jobs[jobId].status = JobStatus.Funded;
    }
}

contract MaiatHookTest is Test {
    MaiatHook hook;
    MaiatOracle oracle;
    MockACPForHook mockACP;

    address owner = address(this);
    address oracleOperator = address(0xBEEF);
    address provider = address(0x2222);
    address client = address(0x1111);
    address nonOwner = address(0xDEAD);

    uint8 constant DEFAULT_MIN_TRUST = 50;
    uint256 constant JOB_ID = 1;

    event OracleUpdated(address indexed oldOracle, address indexed newOracle);
    event DefaultMinTrustScoreUpdated(uint8 oldScore, uint8 newScore);
    event JobMinTrustScoreSet(uint256 indexed jobId, uint8 minScore);
    event JobMinTrustScoreCleared(uint256 indexed jobId);
    event CompletionRecorded(uint256 indexed jobId, address indexed provider);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    function setUp() public {
        oracle = new MaiatOracle(oracleOperator);
        mockACP = new MockACPForHook();

        hook = new MaiatHook(address(mockACP), address(oracle), DEFAULT_MIN_TRUST);

        // Set hook in mock ACP
        mockACP.setHook(address(hook));

        // Set up provider trust score
        vm.prank(oracleOperator);
        oracle.updateScore(provider, 80, "proceed", 1, "agent_trust");

        // Create a test job
        _createOpenJob(JOB_ID);
    }

    function _createOpenJob(uint256 jobId) internal {
        IAgenticCommerce.Job memory job = IAgenticCommerce.Job({
            client: client,
            provider: provider,
            evaluator: address(0),
            budget: 1 ether,
            expiredAt: uint64(block.timestamp + 1 days),
            status: IAgenticCommerce.JobStatus.Open,
            hook: address(hook),
            description: "Test job"
        });
        mockACP.setJob(jobId, job);
    }

    // ── Constructor ───────────────────────────────────────────────────────

    function test_constructor_setsCorrectValues() public view {
        assertEq(address(hook.acp()), address(mockACP));
        assertEq(address(hook.oracle()), address(oracle));
        assertEq(hook.defaultMinTrustScore(), DEFAULT_MIN_TRUST);
        assertEq(hook.owner(), owner);
    }

    function test_constructor_revertsOnZeroACP() public {
        vm.expectRevert(MaiatHook.ZeroAddress.selector);
        new MaiatHook(address(0), address(oracle), DEFAULT_MIN_TRUST);
    }

    function test_constructor_revertsOnZeroOracle() public {
        vm.expectRevert(MaiatHook.ZeroAddress.selector);
        new MaiatHook(address(mockACP), address(0), DEFAULT_MIN_TRUST);
    }

    function test_constructor_revertsOnScoreTooHigh() public {
        vm.expectRevert(abi.encodeWithSelector(MaiatHook.ScoreTooHigh.selector, 101, 100));
        new MaiatHook(address(mockACP), address(oracle), 101);
    }

    // ── beforeAction ──────────────────────────────────────────────────────

    function test_beforeAction_allowsHighTrustProvider() public {
        // Provider has 80 trust, default min is 50
        vm.prank(address(mockACP));
        mockACP.fund(JOB_ID, 1 ether, "");

        // Should succeed (no revert)
        IAgenticCommerce.Job memory job = mockACP.getJob(JOB_ID);
        assertEq(uint8(job.status), uint8(IAgenticCommerce.JobStatus.Funded));
    }

    function test_beforeAction_blocksLowTrustProvider() public {
        // Lower provider trust score
        vm.prank(oracleOperator);
        oracle.updateScore(provider, 30, "caution", 2, "agent_trust");

        vm.prank(address(mockACP));
        vm.expectRevert(abi.encodeWithSelector(MaiatHook.TrustScoreTooLow.selector, 30, DEFAULT_MIN_TRUST));
        mockACP.fund(JOB_ID, 1 ether, "");
    }

    function test_beforeAction_usesJobOverride() public {
        // Set high per-job minimum
        hook.setJobMinTrustScore(JOB_ID, 90);

        // Provider has 80 trust, but job requires 90
        vm.prank(address(mockACP));
        vm.expectRevert(abi.encodeWithSelector(MaiatHook.TrustScoreTooLow.selector, 80, 90));
        mockACP.fund(JOB_ID, 1 ether, "");
    }

    function test_beforeAction_revertsOnNonACP() public {
        bytes4 fundSelector = hook.FUND_SELECTOR();
        vm.prank(nonOwner);
        vm.expectRevert(MaiatHook.NotACP.selector);
        hook.beforeAction(JOB_ID, fundSelector, "");
    }

    function test_beforeAction_ignoresOtherSelectors() public {
        // Should not revert for non-fund selectors, even with low trust
        vm.prank(oracleOperator);
        oracle.updateScore(provider, 10, "avoid", 2, "agent_trust");

        vm.prank(address(mockACP));
        hook.beforeAction(JOB_ID, bytes4(keccak256("submit(uint256,bytes,bytes)")), "");
        // Should succeed (no trust check for non-fund actions)
    }

    // ── afterAction ───────────────────────────────────────────────────────

    function test_afterAction_recordsCompletion() public {
        // Fund first
        vm.prank(address(mockACP));
        mockACP.fund(JOB_ID, 1 ether, "");

        // Change status to Submitted for the complete call
        IAgenticCommerce.Job memory job = mockACP.getJob(JOB_ID);
        job.status = IAgenticCommerce.JobStatus.Submitted;
        mockACP.setJob(JOB_ID, job);

        uint256 countBefore = hook.completionCount();

        vm.expectEmit(true, true, false, false);
        emit CompletionRecorded(JOB_ID, provider);

        // Complete will trigger afterAction
        vm.prank(address(mockACP));
        mockACP.complete(JOB_ID, "done", "");

        assertEq(hook.completionCount(), countBefore + 1);
    }

    function test_afterAction_revertsOnNonACP() public {
        bytes4 completeSelector = hook.COMPLETE_SELECTOR();
        vm.prank(nonOwner);
        vm.expectRevert(MaiatHook.NotACP.selector);
        hook.afterAction(JOB_ID, completeSelector, "");
    }

    function test_afterAction_ignoresOtherSelectors() public {
        uint256 countBefore = hook.completionCount();

        vm.prank(address(mockACP));
        hook.afterAction(JOB_ID, bytes4(keccak256("reject(uint256,string,bytes)")), "");

        // Count should not increase
        assertEq(hook.completionCount(), countBefore);
    }

    // ── View Functions ────────────────────────────────────────────────────

    function test_getEffectiveMinTrustScore_returnsDefault() public view {
        assertEq(hook.getEffectiveMinTrustScore(JOB_ID), DEFAULT_MIN_TRUST);
    }

    function test_getEffectiveMinTrustScore_returnsOverride() public {
        hook.setJobMinTrustScore(JOB_ID, 75);
        assertEq(hook.getEffectiveMinTrustScore(JOB_ID), 75);
    }

    function test_wouldPassTrustCheck_returnsTrue() public view {
        assertTrue(hook.wouldPassTrustCheck(JOB_ID, provider));
    }

    function test_wouldPassTrustCheck_returnsFalse() public {
        vm.prank(oracleOperator);
        oracle.updateScore(provider, 30, "caution", 2, "agent_trust");
        assertFalse(hook.wouldPassTrustCheck(JOB_ID, provider));
    }

    // ── Configuration ─────────────────────────────────────────────────────

    function test_setJobMinTrustScore_success() public {
        vm.expectEmit(true, false, false, true);
        emit JobMinTrustScoreSet(JOB_ID, 70);

        hook.setJobMinTrustScore(JOB_ID, 70);

        assertEq(hook.jobMinTrustScore(JOB_ID), 70);
        assertTrue(hook.hasJobOverride(JOB_ID));
    }

    function test_setJobMinTrustScore_revertsOnNonOwner() public {
        vm.prank(nonOwner);
        vm.expectRevert(MaiatHook.NotOwner.selector);
        hook.setJobMinTrustScore(JOB_ID, 70);
    }

    function test_setJobMinTrustScore_revertsOnScoreTooHigh() public {
        vm.expectRevert(abi.encodeWithSelector(MaiatHook.ScoreTooHigh.selector, 101, 100));
        hook.setJobMinTrustScore(JOB_ID, 101);
    }

    function test_clearJobMinTrustScore_success() public {
        hook.setJobMinTrustScore(JOB_ID, 70);
        assertTrue(hook.hasJobOverride(JOB_ID));

        vm.expectEmit(true, false, false, false);
        emit JobMinTrustScoreCleared(JOB_ID);

        hook.clearJobMinTrustScore(JOB_ID);

        assertFalse(hook.hasJobOverride(JOB_ID));
        assertEq(hook.getEffectiveMinTrustScore(JOB_ID), DEFAULT_MIN_TRUST);
    }

    function test_setDefaultMinTrustScore_success() public {
        vm.expectEmit(false, false, false, true);
        emit DefaultMinTrustScoreUpdated(DEFAULT_MIN_TRUST, 75);

        hook.setDefaultMinTrustScore(75);
        assertEq(hook.defaultMinTrustScore(), 75);
    }

    function test_setDefaultMinTrustScore_revertsOnScoreTooHigh() public {
        vm.expectRevert(abi.encodeWithSelector(MaiatHook.ScoreTooHigh.selector, 101, 100));
        hook.setDefaultMinTrustScore(101);
    }

    function test_setOracle_success() public {
        MaiatOracle newOracle = new MaiatOracle(oracleOperator);

        vm.expectEmit(true, true, false, false);
        emit OracleUpdated(address(oracle), address(newOracle));

        hook.setOracle(address(newOracle));
        assertEq(address(hook.oracle()), address(newOracle));
    }

    function test_setOracle_revertsOnZeroAddress() public {
        vm.expectRevert(MaiatHook.ZeroAddress.selector);
        hook.setOracle(address(0));
    }

    function test_transferOwnership_success() public {
        address newOwner = address(0xCAFE);

        // Step 1: initiate
        hook.transferOwnership(newOwner);
        assertEq(hook.pendingOwner(), newOwner);
        assertEq(hook.owner(), owner);

        // Step 2: accept
        vm.expectEmit(true, true, false, false);
        emit OwnershipTransferred(owner, newOwner);

        vm.prank(newOwner);
        hook.acceptOwnership();
        assertEq(hook.owner(), newOwner);
        assertEq(hook.pendingOwner(), address(0));
    }

    function test_transferOwnership_revertsOnZeroAddress() public {
        vm.expectRevert(MaiatHook.ZeroAddress.selector);
        hook.transferOwnership(address(0));
    }

    // ── Fuzz Tests ────────────────────────────────────────────────────────

    function testFuzz_beforeAction_trustScoreThreshold(uint8 providerScore, uint8 minScore) public {
        vm.assume(providerScore <= 100);
        vm.assume(minScore <= 100);

        // Set provider score
        vm.prank(oracleOperator);
        oracle.updateScore(provider, providerScore, "test", 2, "agent_trust");

        // Set job min score
        hook.setJobMinTrustScore(JOB_ID, minScore);

        if (providerScore < minScore) {
            vm.prank(address(mockACP));
            vm.expectRevert(abi.encodeWithSelector(MaiatHook.TrustScoreTooLow.selector, providerScore, minScore));
            mockACP.fund(JOB_ID, 1 ether, "");
        } else {
            vm.prank(address(mockACP));
            mockACP.fund(JOB_ID, 1 ether, "");
            // Should succeed
        }
    }

    function testFuzz_setJobMinTrustScore_bounds(uint8 score) public {
        if (score > 100) {
            vm.expectRevert(abi.encodeWithSelector(MaiatHook.ScoreTooHigh.selector, score, 100));
            hook.setJobMinTrustScore(JOB_ID, score);
        } else {
            hook.setJobMinTrustScore(JOB_ID, score);
            assertEq(hook.jobMinTrustScore(JOB_ID), score);
        }
    }

    function testFuzz_onlyOwnerCanAdmin(address caller) public {
        vm.assume(caller != owner);
        vm.prank(caller);
        vm.expectRevert(MaiatHook.NotOwner.selector);
        hook.setDefaultMinTrustScore(75);
    }

    function testFuzz_onlyACPCanCallHooks(address caller) public {
        vm.assume(caller != address(mockACP));

        bytes4 fundSelector = hook.FUND_SELECTOR();
        bytes4 completeSelector = hook.COMPLETE_SELECTOR();

        vm.prank(caller);
        vm.expectRevert(MaiatHook.NotACP.selector);
        hook.beforeAction(JOB_ID, fundSelector, "");

        vm.prank(caller);
        vm.expectRevert(MaiatHook.NotACP.selector);
        hook.afterAction(JOB_ID, completeSelector, "");
    }

    function testFuzz_wouldPassTrustCheck_matchesActual(uint8 providerScore) public {
        vm.assume(providerScore <= 100);

        vm.prank(oracleOperator);
        oracle.updateScore(provider, providerScore, "test", 2, "agent_trust");

        bool expected = providerScore >= DEFAULT_MIN_TRUST;
        assertEq(hook.wouldPassTrustCheck(JOB_ID, provider), expected);
    }
}
