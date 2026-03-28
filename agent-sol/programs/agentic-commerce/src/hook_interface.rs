use anchor_lang::prelude::*;

/// Hook Interface — reference for building hook programs.
///
/// Any Solana program that implements these two instructions can be used
/// as a hook for the Agentic Commerce Protocol.
///
/// Hook programs receive CPI calls from the main commerce program
/// before and after each hookable action (set_provider, set_budget,
/// fund, submit, complete, reject).
///
/// claim_refund is deliberately NOT hookable — it's the safety escape.
///
/// ## Instruction Layout
///
/// Both instructions receive:
/// - `job_id: u64` — the job being acted on
/// - `action: u8` — which action (0=SetProvider, 1=SetBudget, 2=Fund, 3=Submit, 4=Complete, 5=Reject)
/// - `data: Vec<u8>` — action-specific encoded params (+ optParams from caller)
///
/// ## Account Layout
///
/// Account 0: Job account (read-only)
/// Account 1: Caller/signer (read-only, verified as signer)
/// Account 2+: Any additional accounts the hook needs (passed via remaining_accounts)
///
/// ## Example Hook Program
///
/// ```rust
/// use anchor_lang::prelude::*;
///
/// #[program]
/// pub mod my_hook {
///     use super::*;
///
///     pub fn before_action(
///         ctx: Context<HookAction>,
///         job_id: u64,
///         action: u8,
///         data: Vec<u8>,
///     ) -> Result<()> {
///         // Custom validation logic
///         // Revert to block the action
///         msg!("Hook: before action {} on job {}", action, job_id);
///         Ok(())
///     }
///
///     pub fn after_action(
///         ctx: Context<HookAction>,
///         job_id: u64,
///         action: u8,
///         data: Vec<u8>,
///     ) -> Result<()> {
///         // Side effects: emit events, update state, etc.
///         msg!("Hook: after action {} on job {}", action, job_id);
///         Ok(())
///     }
/// }
///
/// #[derive(Accounts)]
/// pub struct HookAction<'info> {
///     /// The job account (read-only).
///     pub job: UncheckedAccount<'info>,
///     /// The caller who triggered the action.
///     pub caller: Signer<'info>,
/// }
/// ```
///
/// ## Action Data Encoding
///
/// | Action      | Data contents                                    |
/// |-------------|--------------------------------------------------|
/// | SetProvider | (Pubkey provider, Vec<u8> optParams)             |
/// | SetBudget   | (u64 amount, Vec<u8> optParams)                  |
/// | Fund        | Vec<u8> optParams (raw)                          |
/// | Submit      | ([u8;32] deliverable, Vec<u8> optParams)         |
/// | Complete    | ([u8;32] reason, Vec<u8> optParams)               |
/// | Reject      | ([u8;32] reason, Vec<u8> optParams)               |
///
/// ## Security Notes
///
/// - Hooks are trusted. A buggy hook can block all actions until expiry.
/// - The safety net is `claim_refund` — not hookable, always available after expiry.
/// - Audit your hooks. Verify they don't have unbounded loops or excessive compute.
/// - The commerce program does NOT pass any PDA seeds or authorities to hooks.
///   Hooks cannot move funds from the escrow vault.
pub struct _HookInterfaceDoc;
