// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IAgenticCommerce
 * @notice Minimal interface for ERC-8183 Agentic Commerce Protocol
 * @dev Defines the core types and functions needed for Maiat integration
 *
 * @custom:erc ERC-8183
 */
interface IAgenticCommerce {
    // ── Enums ────────────────────────────────────────────────────────────────

    /// @notice Job lifecycle states
    enum JobStatus {
        Open, // Job created, awaiting funding
        Funded, // Client has funded escrow
        Submitted, // Provider has submitted deliverable
        Completed, // Evaluator approved, provider paid
        Rejected, // Evaluator rejected or client cancelled
        Expired // Job expired without completion
    }

    // ── Structs ──────────────────────────────────────────────────────────────

    /// @notice Core job data structure
    struct Job {
        address client; // Job creator / payer
        address provider; // Service provider
        address evaluator; // Authorized evaluator contract
        uint256 budget; // Escrowed payment amount
        uint64 expiredAt; // Expiration timestamp
        JobStatus status; // Current job state
        address hook; // Optional IACPHook contract
        string description; // Job description / requirements
    }

    // ── Core Functions ───────────────────────────────────────────────────────

    /// @notice Get job details by ID
    /// @param jobId The unique job identifier
    /// @return job The job struct
    function getJob(uint256 jobId) external view returns (Job memory job);

    /// @notice Complete a job (only evaluator can call when status is Submitted)
    /// @param jobId The job to complete
    /// @param reason Completion reason/notes
    /// @param optParams Optional parameters (implementation-specific)
    function complete(uint256 jobId, string calldata reason, bytes calldata optParams) external;

    /// @notice Reject a job (evaluator when Funded/Submitted, client when Open)
    /// @param jobId The job to reject
    /// @param reason Rejection reason
    /// @param optParams Optional parameters (implementation-specific)
    function reject(uint256 jobId, string calldata reason, bytes calldata optParams) external;

    /// @notice Get the escrow balance for a job
    /// @param jobId The job ID
    /// @return amount The escrowed amount
    function getEscrowBalance(uint256 jobId) external view returns (uint256 amount);
}

/**
 * @title IACPHook
 * @notice Hook interface for ACP job lifecycle events
 * @dev Implementations can add custom logic before/after job actions
 */
interface IACPHook {
    /// @notice Called before a job action is executed
    /// @param jobId The job ID
    /// @param selector The function selector being called
    /// @param data Additional context data
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external;

    /// @notice Called after a job action is executed
    /// @param jobId The job ID
    /// @param selector The function selector being called
    /// @param data Additional context data
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
}
