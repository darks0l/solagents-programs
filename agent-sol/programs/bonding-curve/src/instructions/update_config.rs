use anchor_lang::prelude::*;
use crate::state::CurveConfig;
use crate::errors::CurveError;
use crate::constants::MAX_TOTAL_FEE_BPS;

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [CurveConfig::SEED],
        bump = config.bump,
        constraint = config.admin == admin.key() @ CurveError::Unauthorized,
    )]
    pub config: Account<'info, CurveConfig>,
}

pub fn handler(
    ctx: Context<UpdateConfig>,
    new_creator_fee_bps: Option<u16>,
    new_platform_fee_bps: Option<u16>,
    new_graduation_threshold: Option<u64>,
    new_treasury: Option<Pubkey>,
    new_admin: Option<Pubkey>,
    paused: Option<bool>,
    raydium_permission_enabled: Option<bool>,
) -> Result<()> {
    let config = &mut ctx.accounts.config;

    let old_creator_fee = config.creator_fee_bps;
    let old_platform_fee = config.platform_fee_bps;
    let old_threshold = config.graduation_threshold;
    let old_treasury = config.treasury;
    let old_admin = config.admin;
    let old_paused = config.paused;
    let old_raydium_permission = config.raydium_permission_enabled;

    // Apply updates
    if let Some(fee) = new_creator_fee_bps {
        config.creator_fee_bps = fee;
    }
    if let Some(fee) = new_platform_fee_bps {
        config.platform_fee_bps = fee;
    }

    // Validate combined fees
    require!(
        config.creator_fee_bps + config.platform_fee_bps <= MAX_TOTAL_FEE_BPS,
        CurveError::InvalidFees
    );

    if let Some(threshold) = new_graduation_threshold {
        require!(threshold > 0, CurveError::InvalidThreshold);
        config.graduation_threshold = threshold;
    }
    if let Some(treasury) = new_treasury {
        config.treasury = treasury;
    }
    if let Some(admin) = new_admin {
        config.admin = admin;
    }
    if let Some(p) = paused {
        config.paused = p;
    }
    if let Some(rp) = raydium_permission_enabled {
        config.raydium_permission_enabled = rp;
    }

    emit!(ConfigUpdated {
        admin: config.admin,
        old_creator_fee_bps: old_creator_fee,
        new_creator_fee_bps: config.creator_fee_bps,
        old_platform_fee_bps: old_platform_fee,
        new_platform_fee_bps: config.platform_fee_bps,
        old_graduation_threshold: old_threshold,
        new_graduation_threshold: config.graduation_threshold,
        old_treasury,
        new_treasury: config.treasury,
        old_admin,
        new_admin: config.admin,
        old_paused,
        new_paused: config.paused,
        old_raydium_permission,
        new_raydium_permission: config.raydium_permission_enabled,
    });

    Ok(())
}

#[event]
pub struct ConfigUpdated {
    pub admin: Pubkey,
    pub old_creator_fee_bps: u16,
    pub new_creator_fee_bps: u16,
    pub old_platform_fee_bps: u16,
    pub new_platform_fee_bps: u16,
    pub old_graduation_threshold: u64,
    pub new_graduation_threshold: u64,
    pub old_treasury: Pubkey,
    pub new_treasury: Pubkey,
    pub old_admin: Pubkey,
    pub new_admin: Pubkey,
    pub old_paused: bool,
    pub new_paused: bool,
    pub old_raydium_permission: bool,
    pub new_raydium_permission: bool,
}
