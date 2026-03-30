use anchor_lang::prelude::*;

/// Job status — mirrors EIP-8183 state machine exactly.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum JobStatus {
    /// Created; budget not yet set or not yet funded.
    Open,
    /// Budget escrowed. Provider may submit work.
    Funded,
    /// Provider has submitted work. Evaluator may complete or reject.
    Submitted,
    /// Terminal. Escrow released to provider.
    Completed,
    /// Terminal. Escrow refunded to client.
    Rejected,
    /// Terminal. Escrow refunded to client after expiry.
    Expired,
}

impl Default for JobStatus {
    fn default() -> Self {
        JobStatus::Open
    }
}

/// Action identifiers for hook callbacks — equivalent to Solidity function selectors.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum ActionKind {
    SetProvider = 0,
    SetBudget = 1,
    Fund = 2,
    Submit = 3,
    Complete = 4,
    Reject = 5,
    // ClaimRefund is deliberately NOT hookable (safety)
}

/// Platform configuration — owned by admin, stores fee settings.
#[account]
pub struct PlatformConfig {
    /// Admin authority — can update config.
    pub admin: Pubkey,
    /// Fee in basis points (0-10000). Applied on completion only.
    pub fee_bps: u16,
    /// Treasury that receives platform fees.
    pub treasury: Pubkey,
    /// SPL token mint used for all jobs (e.g., USDC).
    pub payment_mint: Pubkey,
    /// Total jobs created (used as counter for job IDs).
    pub job_counter: u64,
    /// Bump for the config PDA.
    pub bump: u8,
    /// Whether job creation is paused.
    pub paused: bool,
    /// Proposed new admin (two-step transfer). Pubkey::default() = no pending transfer.
    pub pending_admin: Pubkey,
}

impl PlatformConfig {
    pub const SIZE: usize = 8  // discriminator
        + 32  // admin
        + 2   // fee_bps
        + 32  // treasury
        + 32  // payment_mint
        + 8   // job_counter
        + 1   // bump
        + 1   // paused
        + 32; // pending_admin
}

/// A single job — the core data structure.
/// PDA: ["job", config.key, job_id (u64 LE)]
#[account]
pub struct Job {
    /// Unique job ID (sequential from platform config counter).
    pub job_id: u64,
    /// Client who created the job and funds escrow.
    pub client: Pubkey,
    /// Provider who does the work. May be Pubkey::default() initially.
    pub provider: Pubkey,
    /// Evaluator who attests completion or rejection.
    pub evaluator: Pubkey,
    /// Job description / brief (stored on-chain for discoverability).
    pub description: String,
    /// Budget in token smallest units (e.g., USDC micro-units).
    pub budget: u64,
    /// Unix timestamp after which the job can be refunded.
    pub expired_at: i64,
    /// Current status.
    pub status: JobStatus,
    /// Deliverable reference (hash, IPFS CID, etc.) — set on submit.
    pub deliverable: [u8; 32],
    /// Completion/rejection reason (attestation hash) — set on complete/reject.
    pub reason: [u8; 32],
    /// Optional hook program for before/after callbacks.
    /// Pubkey::default() = no hook.
    pub hook: Pubkey,
    /// Timestamp when job was created.
    pub created_at: i64,
    /// Timestamp when job reached terminal state.
    pub completed_at: i64,
    /// Bump for this job's PDA.
    pub bump: u8,
    /// Bump for this job's escrow vault PDA.
    pub vault_bump: u8,
}

impl Job {
    /// Max description length (256 bytes).
    pub const MAX_DESC_LEN: usize = 256;

    pub const SIZE: usize = 8   // discriminator
        + 8   // job_id
        + 32  // client
        + 32  // provider
        + 32  // evaluator
        + 4 + Self::MAX_DESC_LEN  // description (4-byte len prefix + data)
        + 8   // budget
        + 8   // expired_at
        + 1   // status
        + 32  // deliverable
        + 32  // reason
        + 32  // hook
        + 8   // created_at
        + 8   // completed_at
        + 1   // bump
        + 1;  // vault_bump

    pub fn is_terminal(&self) -> bool {
        matches!(
            self.status,
            JobStatus::Completed | JobStatus::Rejected | JobStatus::Expired
        )
    }

    pub fn is_expired(&self, clock: &Clock) -> bool {
        clock.unix_timestamp >= self.expired_at
    }
}
