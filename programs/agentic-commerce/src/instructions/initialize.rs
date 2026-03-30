use anchor_lang::prelude::*;
use crate::state::PlatformConfig;

/// Initialize the platform configuration. Called once by the admin.
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = PlatformConfig::SIZE,
        seeds = [b"config"],
        bump,
    )]
    pub config: Account<'info, PlatformConfig>,

    /// The SPL token mint for payments (e.g., USDC).
    /// CHECK: We just store the pubkey; validated when used in token operations.
    pub payment_mint: UncheckedAccount<'info>,

    /// Treasury wallet that receives platform fees.
    /// CHECK: We just store the pubkey.
    pub treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Initialize>, fee_bps: u16) -> Result<()> {
    // Hard cap: 10% max fee (1000 bps). Protocol enforced — cannot be overridden.
    require!(fee_bps <= 1_000, crate::errors::CommerceError::FeeTooHigh);

    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.fee_bps = fee_bps;
    config.treasury = ctx.accounts.treasury.key();
    config.payment_mint = ctx.accounts.payment_mint.key();
    config.job_counter = 0;
    config.bump = ctx.bumps.config;
    config.paused = false;
    config.pending_admin = Pubkey::default();

    msg!("Platform initialized. Fee: {} bps, Treasury: {}", fee_bps, config.treasury);
    Ok(())
}
