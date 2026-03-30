use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Mint};
use crate::state::{CurveConfig, CurvePool, PoolStatus};
use crate::errors::CurveError;

/// Close a graduated pool's accounts and reclaim rent to treasury.
///
/// Safety checks (all must pass):
/// - Pool status must be `Graduated`
/// - All creator fees must be claimed (`creator_fees_earned == creator_fees_claimed`)
/// - All platform fees must be claimed (`platform_fees_earned == platform_fees_claimed`)
/// - Token vault must be empty (`token_vault.amount == 0`)
/// - Only admin or treasury may call this
///
/// Execution order:
/// 1. Close `token_vault` via SPL `close_account` CPI (rent → treasury, authority = pool PDA)
/// 2. Drain all remaining lamports from `sol_vault` to treasury (system transfer via vault PDA)
/// 3. Anchor's `close = treasury` constraint closes the `pool` account at instruction exit
#[derive(Accounts)]
pub struct CloseGraduatedPool<'info> {
    /// Caller — must be admin or treasury
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [CurveConfig::SEED],
        bump = config.bump,
        constraint = caller.key() == config.admin || caller.key() == config.treasury
            @ CurveError::Unauthorized,
    )]
    pub config: Account<'info, CurveConfig>,

    /// Pool account — closed at instruction exit (rent → treasury)
    #[account(
        mut,
        seeds = [CurvePool::SEED, pool.mint.as_ref()],
        bump = pool.bump,
        close = treasury,
    )]
    pub pool: Account<'info, CurvePool>,

    /// SOL vault — drained to treasury during handler
    /// CHECK: PDA validated by seeds
    #[account(
        mut,
        seeds = [CurvePool::VAULT_SEED, pool.key().as_ref()],
        bump = pool.vault_bump,
    )]
    pub sol_vault: SystemAccount<'info>,

    /// Token vault — closed via SPL CPI during handler
    #[account(
        mut,
        seeds = [CurvePool::TOKEN_VAULT_SEED, pool.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = pool,
    )]
    pub token_vault: Account<'info, TokenAccount>,

    /// The token mint for this pool
    #[account(address = pool.mint)]
    pub mint: Account<'info, Mint>,

    /// Treasury — receives all reclaimed rent and remaining SOL
    /// CHECK: Validated by config.treasury address constraint
    #[account(
        mut,
        address = config.treasury,
    )]
    pub treasury: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CloseGraduatedPool>) -> Result<()> {
    let pool = &ctx.accounts.pool;

    // ── Safety checks ────────────────────────────────────────────────────
    require!(
        pool.status == PoolStatus::Graduated,
        CurveError::NotGraduated
    );

    require!(
        pool.creator_fees_earned == pool.creator_fees_claimed,
        CurveError::UnclaimedFees
    );

    require!(
        pool.platform_fees_earned == pool.platform_fees_claimed,
        CurveError::UnclaimedFees
    );

    require!(
        ctx.accounts.token_vault.amount == 0,
        CurveError::VaultNotEmpty
    );

    // Capture PDA seeds before any moves
    let mint_key = pool.mint;
    let pool_bump = pool.bump;
    let pool_key = pool.key();
    let vault_bump = pool.vault_bump;

    let pool_seeds: &[&[u8]] = &[CurvePool::SEED, mint_key.as_ref(), &[pool_bump]];

    // ── Close token vault (SPL close_account CPI) ────────────────────────
    // Pool PDA is the authority; rent goes to treasury.
    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        token::CloseAccount {
            account: ctx.accounts.token_vault.to_account_info(),
            destination: ctx.accounts.treasury.to_account_info(),
            authority: ctx.accounts.pool.to_account_info(),
        },
        &[pool_seeds],
    ))?;

    msg!("Token vault closed, rent reclaimed to treasury");

    // ── Drain sol_vault → treasury ───────────────────────────────────────
    // Transfer ALL remaining lamports (rent + any residual SOL) to treasury.
    // The account will be cleaned up by the runtime once it reaches 0 lamports.
    let vault_lamports = ctx.accounts.sol_vault.lamports();

    if vault_lamports > 0 {
        let vault_seeds: &[&[u8]] = &[
            CurvePool::VAULT_SEED,
            pool_key.as_ref(),
            &[vault_bump],
        ];

        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.sol_vault.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
                &[vault_seeds],
            ),
            vault_lamports,
        )?;

        msg!("Drained {} lamports from sol_vault to treasury", vault_lamports);
    }

    // Note: pool account is closed by Anchor's `close = treasury` constraint after this handler.

    emit!(GraduatedPoolClosed {
        pool: pool_key,
        mint: mint_key,
        treasury: ctx.accounts.treasury.key(),
        vault_lamports_reclaimed: vault_lamports,
    });

    Ok(())
}

#[event]
pub struct GraduatedPoolClosed {
    pub pool: Pubkey,
    pub mint: Pubkey,
    pub treasury: Pubkey,
    pub vault_lamports_reclaimed: u64,
}
