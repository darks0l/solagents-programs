use anchor_lang::prelude::*;
use crate::state::CurvePool;
use crate::errors::CurveError;

/// Fix pool migration: realloc CurvePool accounts to correct new size.
/// New fields (referrals_enabled, referral_fees_paid) are appended AFTER bump/vault_bump,
/// so existing Borsh data layout is preserved. Zero-filled extension = safe defaults.
///
/// Handles accounts at any of these sizes:
///   - 537 bytes (original, never migrated)
///   - 554 bytes (from previous bad migration with wrong size)
///   - 546 bytes (already correct)
#[derive(Accounts)]
pub struct MigratePool<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: We validate discriminator manually to avoid deserialization failure
    /// on undersized/mis-sized accounts.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<MigratePool>) -> Result<()> {
    let pool_info = &ctx.accounts.pool;
    let current_size = pool_info.data_len();

    // Target: 8 (discriminator) + CurvePool::INIT_SPACE
    let target_size = 8 + CurvePool::INIT_SPACE;

    // Validate discriminator
    {
        let data = pool_info.try_borrow_data()?;
        require!(data.len() >= 8, CurveError::MathOverflow);
        let disc = &data[0..8];
        let expected_disc = anchor_lang::solana_program::hash::hash(b"account:CurvePool");
        let expected = &expected_disc.to_bytes()[0..8];
        require!(disc == expected, CurveError::Unauthorized);
    }

    if current_size == target_size {
        // Might still need zero-fill from a previous bad migration
        // Zero bytes from position 537 (old end) to target_size - 1
        let mut data = pool_info.try_borrow_mut_data()?;
        let old_end = 537usize; // original pool size
        for i in old_end..target_size {
            data[i] = 0;
        }
        msg!("Pool already at target size ({}), zeroed trailing bytes", target_size);
        return Ok(());
    }

    msg!("Migrating pool: {} -> {} bytes", current_size, target_size);

    if current_size > target_size {
        // Shrink (from 554 → target). First zero the referral field area, then realloc down.
        {
            let mut data = pool_info.try_borrow_mut_data()?;
            let old_end = 537usize;
            for i in old_end..current_size.min(target_size) {
                data[i] = 0;
            }
        }
        pool_info.realloc(target_size, false)?;

        // Return excess rent
        let rent = Rent::get()?;
        let new_min = rent.minimum_balance(target_size);
        let excess = pool_info.lamports().saturating_sub(new_min);
        if excess > 0 {
            **pool_info.try_borrow_mut_lamports()? -= excess;
            **ctx.accounts.payer.try_borrow_mut_lamports()? += excess;
            msg!("Returned {} lamports excess rent", excess);
        }
    } else {
        // Grow (from 537 → target). Use zero_init = true to zero new bytes.
        pool_info.realloc(target_size, true)?;

        // Transfer rent difference
        let rent = Rent::get()?;
        let new_min = rent.minimum_balance(target_size);
        let current_lamports = pool_info.lamports();
        if new_min > current_lamports {
            let diff = new_min - current_lamports;
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: pool_info.to_account_info(),
                    },
                ),
                diff,
            )?;
            msg!("Transferred {} lamports for rent", diff);
        }
    }

    // Final safety: zero-fill the new field area regardless
    {
        let mut data = pool_info.try_borrow_mut_data()?;
        let old_end = 537usize;
        for i in old_end..target_size {
            data[i] = 0;
        }
    }

    msg!("Pool migration complete! New size: {} bytes", target_size);
    Ok(())
}
