use anchor_lang::prelude::*;
use anchor_lang::{AnchorDeserialize, AnchorSerialize};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_instruction;
use crate::state::{CurveConfig, CurvePool};
use crate::errors::CurveError;

/// Batch claim platform fees across multiple pools in a single transaction.
///
/// Treasury signs once. `remaining_accounts` must contain sequential [pool, sol_vault] pairs.
/// Each pair is validated: pool PDA is derived from its stored mint, vault PDA is derived from
/// the pool key. Pools with zero claimable fees are skipped.
///
/// Uses raw account deserialization (skipping the 8-byte Anchor discriminator) to allow
/// mutable access to pool state without Anchor's account validation framework.
#[derive(Accounts)]
pub struct ClaimAllPlatformFees<'info> {
    #[account(mut)]
    pub treasury: Signer<'info>,

    #[account(
        seeds = [CurveConfig::SEED],
        bump = config.bump,
        constraint = config.treasury == treasury.key() @ CurveError::Unauthorized,
    )]
    pub config: Account<'info, CurveConfig>,

    pub system_program: Program<'info, System>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, ClaimAllPlatformFees<'info>>,
) -> Result<()> {
    let remaining = ctx.remaining_accounts;

    // Must have at least one [pool, vault] pair, all pairs complete
    require!(!remaining.is_empty(), CurveError::NoFeesToClaim);
    require!(remaining.len() % 2 == 0, CurveError::MathOverflow);

    let mut total_claimed: u64 = 0;
    let mut pools_claimed: u64 = 0;

    for chunk in remaining.chunks(2) {
        let pool_info = &chunk[0];
        let vault_info = &chunk[1];

        // ── Deserialize pool (skip 8-byte Anchor discriminator) ────────────
        let mut pool_data = pool_info.try_borrow_mut_data()?;

        let pool: CurvePool = {
            let src = &pool_data[..];
            let mut src_ref: &[u8] = src;
            CurvePool::try_deserialize(&mut src_ref)?
        };

        // ── Validate pool PDA ───────────────────────────────────────────────
        let (expected_pool, _) = Pubkey::find_program_address(
            &[CurvePool::SEED, pool.mint.as_ref()],
            ctx.program_id,
        );
        require!(pool_info.key() == expected_pool, CurveError::Unauthorized);

        // ── Validate vault PDA ──────────────────────────────────────────────
        let (expected_vault, vault_bump) = Pubkey::find_program_address(
            &[CurvePool::VAULT_SEED, pool_info.key().as_ref()],
            ctx.program_id,
        );
        require!(vault_info.key() == expected_vault, CurveError::Unauthorized);

        // ── Calculate claimable amount ──────────────────────────────────────
        let claimable = pool
            .platform_fees_earned
            .checked_sub(pool.platform_fees_claimed)
            .ok_or(CurveError::MathOverflow)?;

        if claimable == 0 {
            // No fees to claim from this pool — skip it
            continue;
        }

        // ── Transfer SOL from vault to treasury ─────────────────────────────
        let pool_key = pool_info.key();
        let vault_seeds: &[&[u8]] = &[
            CurvePool::VAULT_SEED,
            pool_key.as_ref(),
            &[vault_bump],
        ];

        invoke_signed(
            &system_instruction::transfer(
                vault_info.key,
                ctx.accounts.treasury.key,
                claimable,
            ),
            &[
                vault_info.clone(),
                ctx.accounts.treasury.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[vault_seeds],
        )?;

        // ── Update pool state and write back (skip 8-byte discriminator) ────
        let mut updated_pool = pool;
        updated_pool.platform_fees_claimed = updated_pool.platform_fees_earned;
        updated_pool.real_sol_balance = updated_pool
            .real_sol_balance
            .checked_sub(claimable)
            .ok_or(CurveError::MathOverflow)?;

        {
            // `&mut [u8]` implements `Write`; pass `&mut writer` so the cursor advances
            let mut writer: &mut [u8] = &mut pool_data[8..];
            AnchorSerialize::serialize(&updated_pool, &mut writer)
                .map_err(|_| error!(CurveError::MathOverflow))?;
        }

        total_claimed = total_claimed
            .checked_add(claimable)
            .ok_or(CurveError::MathOverflow)?;
        pools_claimed += 1;

        msg!(
            "Claimed {} lamports from pool {}",
            claimable,
            pool_info.key()
        );
    }

    require!(total_claimed > 0, CurveError::NoFeesToClaim);

    emit!(AllPlatformFeesClaimed {
        treasury: ctx.accounts.treasury.key(),
        total_claimed,
        pools_claimed,
    });

    Ok(())
}

#[event]
pub struct AllPlatformFeesClaimed {
    pub treasury: Pubkey,
    pub total_claimed: u64,
    pub pools_claimed: u64,
}
