// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IACPHook, IAgenticCommerce} from "./interfaces/IAgenticCommerce.sol";
import {MaiatOracle} from "./MaiatOracle.sol";

/**
 * @title MaiatHook
 * @notice IACPHook implementation for trust-gated ACP job funding
 * @dev Integrates with MaiatOracle to enforce trust score requirements.
 *
 *      beforeAction on fund():
 *        - Checks provider trust score
 *        - Reverts if below minTrustScore (per-job or global default)
 *
 *      afterAction on complete():
 *        - Records completion to MaiatOracle
 *
 * @custom:security-audit
 *   - Only ACP contract can call hook functions
 *   - Owner can configure oracle and default scores
 *   - Per-job overrides supported
 *   - Zero-address validation on admin functions
 */
contract MaiatHook is IACPHook {
    // ── Constants ────────────────────────────────────────────────────────────

    /// @notice Maximum allowed score value
    uint8 public constant MAX_SCORE = 100;

    /// @notice Function selector for IAgenticCommerce.fund
    bytes4 public constant FUND_SELECTOR = bytes4(keccak256("fund(uint256,uint256,bytes)"));

    /// @notice Function selector for IAgenticCommerce.complete
    bytes4 public constant COMPLETE_SELECTOR = bytes4(keccak256("complete(uint256,string,bytes)"));

    // ── Immutables ───────────────────────────────────────────────────────────

    /// @notice The ACP job contract
    IAgenticCommerce public immutable acp;

    // ── State ────────────────────────────────────────────────────────────────

    /// @notice Contract owner
    address public owner;

    /// @notice Pending owner for 2-step transfer
    address public pendingOwner;

    /// @notice MaiatOracle for trust scores
    MaiatOracle public oracle;

    /// @notice Maximum acceptable trust score age
    uint256 public constant MAX_SCORE_AGE = 30 days;

    /// @notice Default minimum trust score for all jobs
    uint8 public defaultMinTrustScore;

    /// @notice Per-job minimum trust score override
    mapping(uint256 => uint8) public jobMinTrustScore;

    /// @notice Whether a per-job override is active
    mapping(uint256 => bool) public hasJobOverride;

    /// @notice Jobs completed through this hook
    uint256 public completionCount;

    // ── Events ───────────────────────────────────────────────────────────────

    event OracleUpdated(address indexed oldOracle, address indexed newOracle);
    event DefaultMinTrustScoreUpdated(uint8 oldScore, uint8 newScore);
    event JobMinTrustScoreSet(uint256 indexed jobId, uint8 minScore);
    event JobMinTrustScoreCleared(uint256 indexed jobId);
    event FundingBlocked(uint256 indexed jobId, address indexed provider, uint8 trustScore, uint8 required);
    event CompletionRecorded(uint256 indexed jobId, address indexed provider);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ── Errors ───────────────────────────────────────────────────────────────

    error NotOwner();
    error NotACP();
    error ZeroAddress();
    error TrustScoreTooLow(uint8 actual, uint8 required);
    error ScoreTooHigh(uint8 score, uint8 max);
    error StaleTrustScore(uint64 updatedAt, uint256 maxAge);
    error NotPendingOwner();

    // ── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyACP() {
        if (msg.sender != address(acp)) revert NotACP();
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────────

    /// @notice Deploy the hook contract
    /// @param _acp ACP job contract address
    /// @param _oracle MaiatOracle contract address
    /// @param _defaultMinTrustScore Default minimum trust score
    constructor(address _acp, address _oracle, uint8 _defaultMinTrustScore) {
        if (_acp == address(0)) revert ZeroAddress();
        if (_oracle == address(0)) revert ZeroAddress();
        if (_defaultMinTrustScore > MAX_SCORE) revert ScoreTooHigh(_defaultMinTrustScore, MAX_SCORE);

        acp = IAgenticCommerce(_acp);
        oracle = MaiatOracle(_oracle);
        defaultMinTrustScore = _defaultMinTrustScore;
        owner = msg.sender;
    }

    // ── IACPHook Implementation ──────────────────────────────────────────────

    /// @notice Called before a job action is executed
    /// @dev Blocks fund() if provider trust score is too low
    /// @param jobId The job ID
    /// @param selector The function selector being called
    /// @param data Additional context data (unused)
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external onlyACP {
        // Silence unused variable warning
        data;

        if (selector == FUND_SELECTOR) {
            _checkProviderTrust(jobId);
        }
    }

    /// @notice Called after a job action is executed
    /// @dev Records completion to oracle
    /// @param jobId The job ID
    /// @param selector The function selector being called
    /// @param data Additional context data (unused)
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external onlyACP {
        // Silence unused variable warning
        data;

        if (selector == COMPLETE_SELECTOR) {
            _recordCompletion(jobId);
        }
    }

    // ── Internal Functions ───────────────────────────────────────────────────

    /// @notice Check provider trust score before funding
    /// @param jobId The job ID
    function _checkProviderTrust(uint256 jobId) internal view {
        IAgenticCommerce.Job memory job = acp.getJob(jobId);

        uint8 minScore = getEffectiveMinTrustScore(jobId);
        (uint8 trustScore,, uint64 updatedAt) = oracle.getTrustScore(job.provider);

        if (trustScore < minScore) {
            revert TrustScoreTooLow(trustScore, minScore);
        }
        // M-3: Check trust score freshness
        if (updatedAt > 0 && block.timestamp - updatedAt > MAX_SCORE_AGE) {
            revert StaleTrustScore(updatedAt, MAX_SCORE_AGE);
        }
    }

    /// @notice Record job completion
    /// @param jobId The job ID
    function _recordCompletion(uint256 jobId) internal {
        IAgenticCommerce.Job memory job = acp.getJob(jobId);

        completionCount++;
        emit CompletionRecorded(jobId, job.provider);

        // Note: Actual score update would be done by Maiat backend
        // via oracle.updateScore() based on evaluation results
    }

    // ── View Functions ───────────────────────────────────────────────────────

    /// @notice Get effective minimum trust score for a job
    /// @param jobId The job ID
    /// @return minScore The minimum trust score required
    function getEffectiveMinTrustScore(uint256 jobId) public view returns (uint8 minScore) {
        if (hasJobOverride[jobId]) {
            return jobMinTrustScore[jobId];
        }
        return defaultMinTrustScore;
    }

    /// @notice Check if a provider would pass the trust check for a job
    /// @param jobId The job ID
    /// @param provider The provider address to check
    /// @return passes True if provider meets trust requirements
    function wouldPassTrustCheck(uint256 jobId, address provider) external view returns (bool passes) {
        uint8 minScore = getEffectiveMinTrustScore(jobId);
        (uint8 trustScore,,) = oracle.getTrustScore(provider);
        return trustScore >= minScore;
    }

    // ── Configuration ────────────────────────────────────────────────────────

    /// @notice Set minimum trust score for a specific job
    /// @param jobId The job ID
    /// @param minScore The minimum trust score
    function setJobMinTrustScore(uint256 jobId, uint8 minScore) external onlyOwner {
        if (minScore > MAX_SCORE) revert ScoreTooHigh(minScore, MAX_SCORE);

        jobMinTrustScore[jobId] = minScore;
        hasJobOverride[jobId] = true;

        emit JobMinTrustScoreSet(jobId, minScore);
    }

    /// @notice Clear per-job trust score override
    /// @param jobId The job ID
    function clearJobMinTrustScore(uint256 jobId) external onlyOwner {
        delete jobMinTrustScore[jobId];
        hasJobOverride[jobId] = false;

        emit JobMinTrustScoreCleared(jobId);
    }

    /// @notice Update the default minimum trust score
    /// @param _newScore The new default minimum score
    function setDefaultMinTrustScore(uint8 _newScore) external onlyOwner {
        if (_newScore > MAX_SCORE) revert ScoreTooHigh(_newScore, MAX_SCORE);

        emit DefaultMinTrustScoreUpdated(defaultMinTrustScore, _newScore);
        defaultMinTrustScore = _newScore;
    }

    /// @notice Update the oracle address
    /// @param _newOracle The new oracle address
    function setOracle(address _newOracle) external onlyOwner {
        if (_newOracle == address(0)) revert ZeroAddress();

        emit OracleUpdated(address(oracle), _newOracle);
        oracle = MaiatOracle(_newOracle);
    }

    /// @notice Initiate 2-step ownership transfer
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
