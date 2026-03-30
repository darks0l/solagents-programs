use anchor_lang::prelude::*;
use crate::state::PlatformConfig;
use crate::errors::CommerceError;

/// Update platform configuration. Admin only.
/// Can update fee_bps, treasury, paused state, and propose a new admin.
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
}

pub fn handler(
    ctx: Context<UpdateConfig>,
    new_fee_bps: u16,
    new_treasury: Option<Pubkey>,
    paused: Option<bool>,
    propose_admin: Option<Pubkey>,
) -> Result<()> {
    // Hard cap: 10% max fee (1000 bps). Protocol enforced.
    require!(new_fee_bps <= 1_000, CommerceError::FeeTooHigh);

    let config = &mut ctx.accounts.config;
    let old_fee = config.fee_bps;
    let old_treasury = config.treasury;

    config.fee_bps = new_fee_bps;

    if let Some(treasury) = new_treasury {
        config.treasury = treasury;
    }

    if let Some(p) = paused {
        config.paused = p;
    }

    if let Some(admin) = propose_admin {
        config.pending_admin = admin;
    }

    emit!(ConfigUpdated {
        old_fee_bps: old_fee,
        new_fee_bps,
        old_treasury,
        new_treasury: config.treasury,
        updated_by: ctx.accounts.admin.key(),
        paused: config.paused,
        pending_admin: config.pending_admin,
    });

    msg!(
        "Config updated: fee {} -> {} bps, treasury {} -> {}, paused: {}, pending_admin: {}",
        old_fee, new_fee_bps, old_treasury, config.treasury, config.paused, config.pending_admin
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
    pub paused: bool,
    pub pending_admin: Pubkey,
}
