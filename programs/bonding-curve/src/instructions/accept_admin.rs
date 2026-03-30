use anchor_lang::prelude::*;
use crate::state::CurveConfig;
use crate::errors::CurveError;

/// Two-step admin acceptance.
/// The pending admin signs this instruction to complete the admin transfer.
/// After acceptance, `config.admin` is updated and `config.pending_admin` is reset to default.
#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    /// The new admin — must match config.pending_admin
    #[account(mut)]
    pub pending_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [CurveConfig::SEED],
        bump = config.bump,
        constraint = config.pending_admin != Pubkey::default() @ CurveError::NoPendingAdmin,
        constraint = config.pending_admin == pending_admin.key() @ CurveError::NotPendingAdmin,
    )]
    pub config: Account<'info, CurveConfig>,
}

pub fn handler(ctx: Context<AcceptAdmin>) -> Result<()> {
    let config = &mut ctx.accounts.config;

    let old_admin = config.admin;
    let new_admin = config.pending_admin;

    config.admin = new_admin;
    config.pending_admin = Pubkey::default();

    emit!(AdminTransferred {
        old_admin,
        new_admin,
    });

    Ok(())
}

#[event]
pub struct AdminTransferred {
    pub old_admin: Pubkey,
    pub new_admin: Pubkey,
}
