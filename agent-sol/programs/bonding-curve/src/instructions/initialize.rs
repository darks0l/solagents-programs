use anchor_lang::prelude::*;
use crate::state::CurveConfig;
use crate::errors::CurveError;
use crate::constants::*;

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + CurveConfig::INIT_SPACE,
        seeds = [CurveConfig::SEED],
        bump,
    )]
    pub config: Account<'info, CurveConfig>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<Initialize>,
    creator_fee_bps: u16,
    platform_fee_bps: u16,
    graduation_threshold: u64,
    total_supply: u64,
    decimals: u8,
    initial_virtual_sol: u64,
    treasury: Pubkey,
) -> Result<()> {
    // Validate fees
    require!(
        creator_fee_bps + platform_fee_bps <= MAX_TOTAL_FEE_BPS,
        CurveError::InvalidFees
    );
    require!(graduation_threshold > 0, CurveError::InvalidThreshold);
    require!(total_supply > 0, CurveError::InvalidSupply);
    require!(decimals <= 9, CurveError::InvalidDecimals);
    require!(initial_virtual_sol > 0, CurveError::InvalidThreshold);

    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.treasury = treasury;
    config.creator_fee_bps = creator_fee_bps;
    config.platform_fee_bps = platform_fee_bps;
    config.graduation_threshold = graduation_threshold;
    config.total_supply = total_supply;
    config.decimals = decimals;
    config.initial_virtual_sol = initial_virtual_sol;
    config.paused = false;
    config.raydium_permission_enabled = false; // Default: standard mode until Raydium whitelists us
    config.tokens_created = 0;
    config.tokens_graduated = 0;
    config.trading_paused = false;
    config.pending_admin = Pubkey::default();
    config.bump = ctx.bumps.config;

    emit!(ConfigInitialized {
        admin: config.admin,
        treasury: config.treasury,
        creator_fee_bps,
        platform_fee_bps,
        graduation_threshold,
        total_supply,
        decimals,
        initial_virtual_sol,
    });

    Ok(())
}

#[event]
pub struct ConfigInitialized {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub creator_fee_bps: u16,
    pub platform_fee_bps: u16,
    pub graduation_threshold: u64,
    pub total_supply: u64,
    pub decimals: u8,
    pub initial_virtual_sol: u64,
}
