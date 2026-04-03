use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::DividendError;
use crate::state::{DividendMode, ModeChanged, TokenDividend};

#[derive(Accounts)]
pub struct SetDividendMode<'info> {
    /// Token creator — only they can change mode.
    pub creator: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_TOKEN_DIVIDEND, token_dividend.mint.as_ref()],
        bump = token_dividend.bump,
        constraint = token_dividend.creator == creator.key() @ DividendError::Unauthorized,
    )]
    pub token_dividend: Account<'info, TokenDividend>,
}

/// Creator switches between Regular / Dividend / BuybackBurn.
/// 7-day cooldown between switches.
/// Cannot switch away from Dividend while tokens are staked.
pub fn handler(ctx: Context<SetDividendMode>, new_mode: DividendMode) -> Result<()> {
    let td = &mut ctx.accounts.token_dividend;
    let clock = Clock::get()?;

    let old_mode = td.mode;

    // No-op if same mode
    if old_mode == new_mode {
        return Ok(());
    }

    // Enforce 7-day cooldown
    let elapsed = clock
        .unix_timestamp
        .checked_sub(td.last_mode_change)
        .ok_or(DividendError::MathOverflow)?;
    require!(
        elapsed >= MODE_SWITCH_COOLDOWN,
        DividendError::CooldownNotElapsed
    );

    // Can't switch away from Dividend while tokens are staked
    if old_mode == DividendMode::Dividend {
        require!(td.total_staked == 0, DividendError::StakingNotActive);
    }

    td.mode = new_mode;
    td.last_mode_change = clock.unix_timestamp;

    emit!(ModeChanged {
        mint: td.mint,
        old_mode,
        new_mode,
    });

    Ok(())
}
