use anchor_lang::prelude::*;
use crate::state::PlatformConfig;
use crate::errors::CommerceError;

/// Update platform configuration. Admin only.
/// Can update fee_bps and/or treasury address.
#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        constraint = config.admin == admin.key() @ CommerceError::UnauthorizedClient,
    )]
    pub config: Account<'info, PlatformConfig>,

    /// New treasury address (optional — pass current treasury to keep unchanged).
    /// CHECK: We just store the pubkey.
    pub new_treasury: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<UpdateConfig>, new_fee_bps: u16) -> Result<()> {
    // Hard cap: 10% max fee (1000 bps). Protocol enforced.
    require!(new_fee_bps <= 1_000, CommerceError::FeeTooHigh);

    let config = &mut ctx.accounts.config;
    let old_fee = config.fee_bps;
    let old_treasury = config.treasury;

    config.fee_bps = new_fee_bps;
    config.treasury = ctx.accounts.new_treasury.key();

    emit!(ConfigUpdated {
        old_fee_bps: old_fee,
        new_fee_bps,
        old_treasury,
        new_treasury: config.treasury,
        updated_by: ctx.accounts.admin.key(),
    });

    msg!(
        "Config updated: fee {} -> {} bps, treasury {} -> {}",
        old_fee, new_fee_bps, old_treasury, config.treasury
    );
    Ok(())
}

#[event]
pub struct ConfigUpdated {
    pub old_fee_bps: u16,
    pub new_fee_bps: u16,
    pub old_treasury: Pubkey,
    pub new_treasury: Pubkey,
    pub updated_by: Pubkey,
}
