use anchor_lang::prelude::*;
use crate::state::CurveConfig;
use crate::errors::CurveError;

/// One-time migration: realloc CurveConfig to accommodate new fields.
/// New fields (trading_paused, pending_admin) are appended after bump,
/// so existing data layout is preserved. Zero-filled extension = safe defaults.
///
/// Remove this instruction after migration is complete.
#[derive(Accounts)]
pub struct MigrateConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: We validate seeds and discriminator manually to avoid deserialization failure
    /// on the undersized account.
    #[account(
        mut,
        seeds = [CurveConfig::SEED],
        bump,
    )]
    pub config: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<MigrateConfig>) -> Result<()> {
    let config_info = &ctx.accounts.config;
    let data = config_info.try_borrow_data()?;

    // Validate discriminator (first 8 bytes must match CurveConfig)
    require!(data.len() >= 8, CurveError::MathOverflow);

    // Read admin pubkey from offset 8 (first field after discriminator)
    require!(data.len() >= 40, CurveError::MathOverflow);
    let stored_admin = Pubkey::try_from(&data[8..40]).map_err(|_| CurveError::MathOverflow)?;
    require!(stored_admin == ctx.accounts.admin.key(), CurveError::Unauthorized);

    let new_size = 8 + CurveConfig::INIT_SPACE;
    let current_size = data.len();
    drop(data);

    if current_size >= new_size {
        msg!("Config already at target size ({} bytes), no migration needed", current_size);
        return Ok(());
    }

    msg!("Migrating config: {} -> {} bytes", current_size, new_size);

    // Realloc — zero-fills new bytes (trading_paused=false, pending_admin=default)
    config_info.realloc(new_size, false)?;

    // Transfer rent difference
    let rent = Rent::get()?;
    let new_min_balance = rent.minimum_balance(new_size);
    let current_lamports = config_info.lamports();

    if new_min_balance > current_lamports {
        let diff = new_min_balance - current_lamports;
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.admin.to_account_info(),
                    to: config_info.to_account_info(),
                },
            ),
            diff,
        )?;
        msg!("Transferred {} lamports for rent", diff);
    }

    msg!("Config migration complete!");
    Ok(())
}
