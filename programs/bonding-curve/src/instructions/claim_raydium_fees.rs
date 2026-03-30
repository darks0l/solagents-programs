use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount};
use anchor_spl::associated_token::AssociatedToken;
use crate::state::{CurveConfig, CurvePool, PoolStatus};
use crate::errors::CurveError;
use crate::raydium_cpi;

/// Claim Raydium creator fees from a graduated pool, split 50/50.
///
/// Post-graduation, Raydium's CPMM accumulates creator fees on every trade.
/// Our pool PDA was set as pool_creator during graduation, so we can call
/// `collect_creator_fee` via CPI.
///
/// Flow:
/// 1. CPI → Raydium `collect_creator_fee` (fees land in our PDA's token accounts)
/// 2. Split 50% to creator, 50% to platform treasury
///
/// Either the creator or treasury can trigger this.
#[derive(Accounts)]
pub struct ClaimRaydiumFees<'info> {
    #[account(mut)]
    pub claimer: Signer<'info>,

    #[account(
        seeds = [CurveConfig::SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, CurveConfig>,

    #[account(
        mut,
        seeds = [CurvePool::SEED, pool.mint.as_ref()],
        bump = pool.bump,
        constraint = pool.status == PoolStatus::Graduated @ CurveError::NotGraduated,
    )]
    pub pool: Account<'info, CurvePool>,

    // ── Raydium accounts (for collect_creator_fee CPI) ──────

    /// CHECK: Raydium CPMM program. Validated by address.
    #[account(address = raydium_cpi::RAYDIUM_CPMM_PROGRAM)]
    pub raydium_program: UncheckedAccount<'info>,

    /// CHECK: Raydium pool state. Owned by Raydium, validated in CPI.
    #[account(mut)]
    pub raydium_pool_state: UncheckedAccount<'info>,

    /// CHECK: Raydium authority PDA. Derived by Raydium program.
    pub raydium_authority: UncheckedAccount<'info>,

    /// CHECK: Raydium AMM config. Validated in CPI.
    pub raydium_amm_config: UncheckedAccount<'info>,

    /// CHECK: Raydium token 0 vault (agent token). Validated in CPI.
    #[account(mut)]
    pub raydium_token_0_vault: UncheckedAccount<'info>,

    /// CHECK: Raydium token 1 vault (WSOL). Validated in CPI.
    #[account(mut)]
    pub raydium_token_1_vault: UncheckedAccount<'info>,

    /// CHECK: Raydium vault 0 mint (agent token mint). Validated in CPI.
    pub raydium_vault_0_mint: UncheckedAccount<'info>,

    /// CHECK: Raydium vault 1 mint (WSOL mint). Validated in CPI.
    pub raydium_vault_1_mint: UncheckedAccount<'info>,

    // ── Intermediate receiver accounts (our PDA's ATAs) ─────
    // Raydium sends fees here first (pool PDA is pool_creator),
    // then we split to creator + treasury.

    /// PDA's agent token ATA — receives fees from Raydium CPI
    #[account(mut)]
    pub pda_token_0_account: Account<'info, TokenAccount>,

    /// PDA's WSOL ATA — receives fees from Raydium CPI
    #[account(mut)]
    pub pda_token_1_account: Account<'info, TokenAccount>,

    // ── Final fee recipients ────────────────────────────────

    /// CHECK: Creator's agent token account. Receives 50% of token fees. Validated by transfer CPI.
    #[account(mut)]
    pub creator_token_0_account: UncheckedAccount<'info>,

    /// CHECK: Creator's WSOL account. Receives 50% of WSOL fees. Validated by transfer CPI.
    #[account(mut)]
    pub creator_token_1_account: UncheckedAccount<'info>,

    /// CHECK: Treasury's agent token account. Receives 50% of token fees. Validated by transfer CPI.
    #[account(mut)]
    pub treasury_token_0_account: UncheckedAccount<'info>,

    /// CHECK: Treasury's WSOL account. Receives 50% of WSOL fees. Validated by transfer CPI.
    #[account(mut)]
    pub treasury_token_1_account: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    /// CHECK: Token 0 program (may be Token-2022). Validated in Raydium CPI.
    pub token_0_program: UncheckedAccount<'info>,
    /// CHECK: Token 1 program (WSOL = standard Token). Validated in Raydium CPI.
    pub token_1_program: UncheckedAccount<'info>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ClaimRaydiumFees>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let config = &ctx.accounts.config;

    // Only creator or treasury can trigger
    require!(
        ctx.accounts.claimer.key() == pool.creator
            || ctx.accounts.claimer.key() == config.treasury,
        CurveError::Unauthorized
    );

    let mint_key = pool.mint;
    let pool_seeds: &[&[u8]] = &[
        CurvePool::SEED,
        mint_key.as_ref(),
        &[pool.bump],
    ];

    // Record balances before CPI
    let token_0_before = ctx.accounts.pda_token_0_account.amount;
    let token_1_before = ctx.accounts.pda_token_1_account.amount;

    // ── CPI: Raydium collect_creator_fee ────────────────────
    // Our pool PDA is the pool_creator on Raydium.
    // PDA signs via invoke_signed.
    raydium_cpi::invoke_collect_creator_fee(
        &ctx.accounts.raydium_program.to_account_info(),
        &pool.to_account_info(),
        &ctx.accounts.raydium_authority.to_account_info(),
        &ctx.accounts.raydium_pool_state.to_account_info(),
        &ctx.accounts.raydium_amm_config.to_account_info(),
        &ctx.accounts.raydium_token_0_vault.to_account_info(),
        &ctx.accounts.raydium_token_1_vault.to_account_info(),
        &ctx.accounts.raydium_vault_0_mint.to_account_info(),
        &ctx.accounts.raydium_vault_1_mint.to_account_info(),
        &ctx.accounts.pda_token_0_account.to_account_info(),
        &ctx.accounts.pda_token_1_account.to_account_info(),
        &ctx.accounts.token_0_program.to_account_info(),
        &ctx.accounts.token_1_program.to_account_info(),
        &ctx.accounts.associated_token_program.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        pool_seeds,
    )?;

    // Reload accounts after CPI to get updated balances
    ctx.accounts.pda_token_0_account.reload()?;
    ctx.accounts.pda_token_1_account.reload()?;

    let token_0_received = ctx.accounts.pda_token_0_account.amount
        .checked_sub(token_0_before)
        .ok_or(CurveError::MathOverflow)?;
    let token_1_received = ctx.accounts.pda_token_1_account.amount
        .checked_sub(token_1_before)
        .ok_or(CurveError::MathOverflow)?;

    if token_0_received == 0 && token_1_received == 0 {
        return Err(CurveError::NoRaydiumFees.into());
    }

    msg!(
        "Raydium fees collected: {} token_0, {} token_1",
        token_0_received, token_1_received
    );

    // ── Split 50/50: creator + treasury ─────────────────────

    if token_0_received > 0 {
        let creator_share = token_0_received / 2;
        let treasury_share = token_0_received - creator_share;

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.pda_token_0_account.to_account_info(),
                    to: ctx.accounts.creator_token_0_account.to_account_info(),
                    authority: pool.to_account_info(),
                },
                &[pool_seeds],
            ),
            creator_share,
        )?;

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.pda_token_0_account.to_account_info(),
                    to: ctx.accounts.treasury_token_0_account.to_account_info(),
                    authority: pool.to_account_info(),
                },
                &[pool_seeds],
            ),
            treasury_share,
        )?;
    }

    if token_1_received > 0 {
        let creator_share = token_1_received / 2;
        let treasury_share = token_1_received - creator_share;

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.pda_token_1_account.to_account_info(),
                    to: ctx.accounts.creator_token_1_account.to_account_info(),
                    authority: pool.to_account_info(),
                },
                &[pool_seeds],
            ),
            creator_share,
        )?;

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.pda_token_1_account.to_account_info(),
                    to: ctx.accounts.treasury_token_1_account.to_account_info(),
                    authority: pool.to_account_info(),
                },
                &[pool_seeds],
            ),
            treasury_share,
        )?;
    }

    // ── Update tracking ─────────────────────────────────────
    pool.raydium_fees_claimed_token_0 = pool.raydium_fees_claimed_token_0
        .checked_add(token_0_received)
        .ok_or(CurveError::MathOverflow)?;
    pool.raydium_fees_claimed_token_1 = pool.raydium_fees_claimed_token_1
        .checked_add(token_1_received)
        .ok_or(CurveError::MathOverflow)?;

    emit!(RaydiumFeesClaimed {
        pool: pool.key(),
        mint: pool.mint,
        creator: pool.creator,
        treasury: config.treasury,
        token_0_total: token_0_received,
        token_1_total: token_1_received,
        creator_token_0_share: token_0_received / 2,
        creator_token_1_share: token_1_received / 2,
        treasury_token_0_share: token_0_received - token_0_received / 2,
        treasury_token_1_share: token_1_received - token_1_received / 2,
    });

    Ok(())
}

#[event]
pub struct RaydiumFeesClaimed {
    pub pool: Pubkey,
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub treasury: Pubkey,
    pub token_0_total: u64,
    pub token_1_total: u64,
    pub creator_token_0_share: u64,
    pub creator_token_1_share: u64,
    pub treasury_token_0_share: u64,
    pub treasury_token_1_share: u64,
}
