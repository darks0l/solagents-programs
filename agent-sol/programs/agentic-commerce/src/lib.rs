use anchor_lang::prelude::*;

pub mod errors;
pub mod hook_interface;
pub mod instructions;
pub mod state;

use instructions::*;

#[cfg(not(feature = "no-entrypoint"))]
use solana_security_txt::security_txt;

declare_id!("Ddpj5GCjz8jFuBQXopUfzxkAmkWPCCwC7mhpL6SY9fdx");

#[cfg(not(feature = "no-entrypoint"))]
security_txt! {
    name: "SolAgents Agentic Commerce",
    project_url: "https://solagents.dev",
    contacts: "email:darksol@agentmail.to,link:https://solagents.dev",
    policy: "https://github.com/darks0l/solagents-programs/blob/main/SECURITY.md",
    preferred_languages: "en",
    source_code: "https://github.com/darks0l/solagents-programs",
    auditors: "None"
}

/// Agentic Commerce Protocol — EIP-8183 on Solana.
///
/// Job escrow with evaluator attestation and composable hooks.
/// State machine: Open → Funded → Submitted → Completed/Rejected/Expired.
///
/// Three roles per job:
///   - Client: creates job, sets budget, funds escrow
///   - Provider: submits deliverable
///   - Evaluator: attests completion or rejection
///
/// Hooks: optional before/after CPI callbacks on all state transitions
/// (except claim_refund — the safety escape hatch).
#[program]
pub mod agentic_commerce {
    use super::*;

    /// Initialize the platform. Called once.
    /// Sets admin, fee basis points, treasury, and payment token mint.
    pub fn initialize(ctx: Context<Initialize>, fee_bps: u16) -> Result<()> {
        instructions::initialize::handler(ctx, fee_bps)
    }

    /// Create a new job.
    /// Provider may be Pubkey::default() (set later via set_provider).
    /// Evaluator is mandatory. Hook is optional (Pubkey::default() = no hook).
    pub fn create_job(
        ctx: Context<CreateJob>,
        provider: Pubkey,
        evaluator: Pubkey,
        expired_at: i64,
        description: String,
        hook: Pubkey,
    ) -> Result<()> {
        instructions::create_job::handler(ctx, provider, evaluator, expired_at, description, hook)
    }

    /// Set the provider on a job created without one.
    /// Client only. Job must be Open with no provider.
    pub fn set_provider(
        ctx: Context<SetProvider>,
        provider: Pubkey,
        opt_params: Vec<u8>,
    ) -> Result<()> {
        instructions::set_provider::handler(ctx, provider, opt_params)
    }

    /// Set or update the budget. Client or provider. Job must be Open.
    pub fn set_budget(
        ctx: Context<SetBudget>,
        amount: u64,
        opt_params: Vec<u8>,
    ) -> Result<()> {
        instructions::set_budget::handler(ctx, amount, opt_params)
    }

    /// Fund the job — transfers budget from client to escrow vault.
    /// Open → Funded. Front-running protection via expected_budget.
    pub fn fund(
        ctx: Context<Fund>,
        expected_budget: u64,
        opt_params: Vec<u8>,
    ) -> Result<()> {
        instructions::fund::handler(ctx, expected_budget, opt_params)
    }

    /// Provider submits deliverable. Funded → Submitted.
    pub fn submit(
        ctx: Context<Submit>,
        deliverable: [u8; 32],
        opt_params: Vec<u8>,
    ) -> Result<()> {
        instructions::submit::handler(ctx, deliverable, opt_params)
    }

    /// Evaluator marks job complete. Submitted → Completed.
    /// Releases escrow to provider (minus platform fee).
    pub fn complete(
        ctx: Context<Complete>,
        reason: [u8; 32],
        opt_params: Vec<u8>,
    ) -> Result<()> {
        instructions::complete::handler(ctx, reason, opt_params)
    }

    /// Reject a job.
    /// Client rejects when Open. Evaluator rejects when Funded/Submitted.
    /// Refunds escrow to client if funded.
    pub fn reject(
        ctx: Context<Reject>,
        reason: [u8; 32],
        opt_params: Vec<u8>,
    ) -> Result<()> {
        instructions::reject::handler(ctx, reason, opt_params)
    }

    /// Claim refund on an expired job. Anyone can call.
    /// Funded/Submitted → Expired. Full refund to client.
    /// NOT HOOKABLE — safety mechanism.
    pub fn claim_refund(ctx: Context<ClaimRefund>) -> Result<()> {
        instructions::claim_refund::handler(ctx)
    }

    /// Update platform configuration. Admin only.
    /// Can update fee_bps, treasury, paused state, and propose a new admin.
    /// Fee cap enforced (max 1000 bps).
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_fee_bps: u16,
        new_treasury: Option<Pubkey>,
        paused: Option<bool>,
        propose_admin: Option<Pubkey>,
    ) -> Result<()> {
        instructions::update_config::handler(ctx, new_fee_bps, new_treasury, paused, propose_admin)
    }

    /// Accept a pending admin transfer. Called by the proposed new admin.
    /// Completes the two-step admin handoff initiated via update_config.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::accept_admin::handler(ctx)
    }

    /// Update the accepted payment mint. Admin only.
    /// Allows switching the SPL token used for job escrows.
    pub fn set_payment_mint(ctx: Context<SetPaymentMint>) -> Result<()> {
        instructions::set_payment_mint::handler(ctx)
    }

    /// Close a terminal job account and reclaim rent.
    /// Only the client can close their own completed/rejected/expired jobs.
    /// Closes both the job account and the vault token account.
    pub fn close_job(ctx: Context<CloseJob>) -> Result<()> {
        instructions::close_job::handler(ctx)
    }
}
