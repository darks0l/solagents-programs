use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_lang::solana_program::system_instruction;
use anchor_spl::token::{self, Token, TokenAccount, Burn};
use anchor_spl::associated_token::AssociatedToken;
use crate::state::{CurveConfig, CurvePool, PoolStatus};
use crate::errors::CurveError;
use crate::raydium_cpi;

/// WSOL mint (native SOL wrapped)
pub mod wsol {
    use anchor_lang::declare_id;
    declare_id!("So11111111111111111111111111111111111111112");
}

/// Graduation: migrate bonding curve liquidity to Raydium CPMM.
///
/// Dual-path design:
///   Path A (permission mode): `initialize_with_permission` — creator fees on all post-grad trades
///   Path B (standard):        `initialize`                 — no post-grad creator fees
///
/// Core mechanic:
/// - Price-matching burn: excess tokens burned so Raydium opens at curve's exact final price
/// - Payer (caller) acts as Raydium "creator" — plain keypair, no data, system transfers work
/// - Pre-transfer: tokens/SOL moved from pool vaults → payer ATAs before Raydium CPI
/// - LP burn: Raydium sends LP tokens to payer's LP ATA; we burn immediately
/// - Permanent liquidity: LP burned = can never be pulled
/// - Permissionless trigger: anyone can call once threshold met
#[derive(Accounts)]
pub struct Graduate<'info> {
    #[account(
        mut,
        constraint = payer.key() == config.admin || payer.key() == config.treasury @ CurveError::Unauthorized,
    )]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [CurveConfig::SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, CurveConfig>,

    #[account(
        mut,
        seeds = [CurvePool::SEED, pool.mint.as_ref()],
        bump = pool.bump,
        constraint = pool.is_active() @ CurveError::AlreadyGraduated,
    )]
    pub pool: Account<'info, CurvePool>,

    /// SOL vault
    /// CHECK: PDA validated by seeds
    #[account(
        mut,
        seeds = [CurvePool::VAULT_SEED, pool.key().as_ref()],
        bump = pool.vault_bump,
    )]
    pub sol_vault: SystemAccount<'info>,

    /// Token vault — remaining tokens transferred to Raydium
    #[account(
        mut,
        seeds = [CurvePool::TOKEN_VAULT_SEED, pool.key().as_ref()],
        bump,
        token::mint = pool.mint,
        token::authority = pool,
    )]
    pub token_vault: Account<'info, TokenAccount>,

    /// The token mint
    /// CHECK: validated via pool.mint constraint
    #[account(mut, address = pool.mint)]
    pub mint: UncheckedAccount<'info>,

    // ── Payer token accounts (Raydium creator = payer) ──────

    /// Payer's ATA for the agent token — funded from token_vault before Raydium CPI
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = payer,
    )]
    pub payer_agent_ata: Account<'info, TokenAccount>,

    /// Payer's WSOL ATA — SOL wrapped here before Raydium CPI
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = wsol_mint,
        associated_token::authority = payer,
    )]
    pub payer_wsol_ata: Account<'info, TokenAccount>,

    // ── Raydium CPMM accounts ───────────────────────────────

    /// Raydium CPMM program
    /// CHECK: Validated by address
    #[account(address = raydium_cpi::RAYDIUM_CPMM_PROGRAM)]
    pub raydium_program: UncheckedAccount<'info>,

    /// Raydium AMM config
    /// CHECK: Owned by Raydium program, validated in CPI
    pub raydium_amm_config: UncheckedAccount<'info>,

    /// Raydium pool state — created by CPI
    /// CHECK: Created by Raydium CPI
    #[account(mut)]
    pub raydium_pool_state: UncheckedAccount<'info>,

    /// Raydium authority PDA
    /// CHECK: Derived by Raydium program
    pub raydium_authority: UncheckedAccount<'info>,

    /// Raydium token 0 vault — created by CPI
    /// CHECK: Created by Raydium CPI
    #[account(mut)]
    pub raydium_token_0_vault: UncheckedAccount<'info>,

    /// Raydium token 1 vault — created by CPI
    /// CHECK: Created by Raydium CPI
    #[account(mut)]
    pub raydium_token_1_vault: UncheckedAccount<'info>,

    /// Raydium LP mint — created by CPI
    /// CHECK: Created by Raydium CPI
    #[account(mut)]
    pub raydium_lp_mint: UncheckedAccount<'info>,

    /// Payer's LP token ATA — created by Raydium CPI (payer pays rent as creator)
    /// We burn LP tokens from here immediately after graduation.
    /// CHECK: Created by Raydium CPI
    #[account(mut)]
    pub lp_token_account: UncheckedAccount<'info>,

    /// Raydium observation state
    /// CHECK: Created by Raydium CPI
    #[account(mut)]
    pub raydium_observation: UncheckedAccount<'info>,

    /// Raydium create pool fee receiver
    /// CHECK: Must match Raydium's expected fee receiver
    #[account(mut)]
    pub create_pool_fee: UncheckedAccount<'info>,

    /// WSOL mint
    /// CHECK: Validated by address
    #[account(address = wsol::ID)]
    pub wsol_mint: UncheckedAccount<'info>,

    /// Raydium Permission PDA (Path A only; pass any account for Path B)
    /// CHECK: Validated in CPI by Raydium when permission mode is active
    pub raydium_permission: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<Graduate>) -> Result<()> {
    let config = &ctx.accounts.config;
    let pool = &mut ctx.accounts.pool;

    // ── Verify graduation threshold ─────────────────────────
    let unclaimed_creator_fees = pool.creator_fees_earned
        .checked_sub(pool.creator_fees_claimed)
        .ok_or(CurveError::MathOverflow)?;
    let unclaimed_platform_fees = pool.platform_fees_earned
        .checked_sub(pool.platform_fees_claimed)
        .ok_or(CurveError::MathOverflow)?;
    let total_unclaimed_fees = unclaimed_creator_fees
        .checked_add(unclaimed_platform_fees)
        .ok_or(CurveError::MathOverflow)?;
    let net_sol = pool.real_sol_balance
        .checked_sub(total_unclaimed_fees)
        .ok_or(CurveError::MathOverflow)?;

    require!(
        net_sol >= config.graduation_threshold,
        CurveError::NotReadyToGraduate
    );

    let sol_for_raydium = net_sol;

    // ── Rent reimbursement for payer (Raydium account creation costs) ──────
    // Deducted from sol_for_raydium before wrapping; sent directly as SOL to payer.
    let rent_reimbursement: u64 = 65_000_000; // 0.065 SOL
    let sol_for_wsol = sol_for_raydium
        .checked_sub(rent_reimbursement)
        .ok_or(CurveError::MathOverflow)?;

    // ── Price-matching: tokens for Raydium ──────────────────
    // tokens_for_raydium = sol_for_wsol * virtual_token / virtual_sol
    // This ensures Raydium opens at the same price as the curve's final spot price.
    let tokens_for_raydium = (sol_for_wsol as u128)
        .checked_mul(pool.virtual_token_reserve as u128)
        .ok_or(CurveError::MathOverflow)?
        .checked_div(pool.virtual_sol_reserve as u128)
        .ok_or(CurveError::MathOverflow)? as u64;

    // Excess tokens burned — they represent the virtual SOL's phantom contribution
    let tokens_to_burn = pool.real_token_balance
        .checked_sub(tokens_for_raydium)
        .ok_or(CurveError::MathOverflow)?;

    msg!("Graduating pool: {} SOL + {} tokens to Raydium, burning {} tokens (rent reimbursement: {} lamports)",
        sol_for_wsol, tokens_for_raydium, tokens_to_burn, rent_reimbursement);
    msg!("Permission mode: {}", config.raydium_permission_enabled);

    // ── Burn excess tokens for price continuity ─────────────
    let mint_key = pool.mint;
    let pool_key = pool.key();
    let pool_bump = pool.bump;
    let vault_bump = pool.vault_bump;

    let pool_seeds: &[&[u8]] = &[CurvePool::SEED, mint_key.as_ref(), &[pool_bump]];
    let vault_seeds: &[&[u8]] = &[CurvePool::VAULT_SEED, pool_key.as_ref(), &[vault_bump]];

    if tokens_to_burn > 0 {
        token::burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.token_vault.to_account_info(),
                    authority: pool.to_account_info(),
                },
                &[pool_seeds],
            ),
            tokens_to_burn,
        )?;
        msg!("Burned {} excess tokens", tokens_to_burn);
    }

    // ── Mint ordering ───────────────────────────────────────
    // Raydium requires token_0_mint < token_1_mint (lexicographic pubkey order)
    let agent_mint_key = ctx.accounts.mint.key();
    let wsol_mint_key = ctx.accounts.wsol_mint.key();
    let agent_is_token_0 = agent_mint_key < wsol_mint_key;

    let (token_0_mint_info, token_1_mint_info) = if agent_is_token_0 {
        (ctx.accounts.mint.to_account_info(), ctx.accounts.wsol_mint.to_account_info())
    } else {
        (ctx.accounts.wsol_mint.to_account_info(), ctx.accounts.mint.to_account_info())
    };
    let (creator_token_0_info, creator_token_1_info) = if agent_is_token_0 {
        (ctx.accounts.payer_agent_ata.to_account_info(), ctx.accounts.payer_wsol_ata.to_account_info())
    } else {
        (ctx.accounts.payer_wsol_ata.to_account_info(), ctx.accounts.payer_agent_ata.to_account_info())
    };
    let (init_amount_0, init_amount_1) = if agent_is_token_0 {
        (tokens_for_raydium, sol_for_wsol)
    } else {
        (sol_for_wsol, tokens_for_raydium)
    };
    let (vault_0_info, vault_1_info) = if agent_is_token_0 {
        (ctx.accounts.raydium_token_0_vault.to_account_info(), ctx.accounts.raydium_token_1_vault.to_account_info())
    } else {
        (ctx.accounts.raydium_token_1_vault.to_account_info(), ctx.accounts.raydium_token_0_vault.to_account_info())
    };
    msg!("agent_is_token_0={}", agent_is_token_0);

    // ── Pre-transfer: agent tokens → payer ATA ──────────────
    // Raydium pulls tokens from creator's ATA (authority = payer).
    // Pool PDA is the current authority of token_vault; transfer via invoke_signed.
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token::Transfer {
                from: ctx.accounts.token_vault.to_account_info(),
                to: ctx.accounts.payer_agent_ata.to_account_info(),
                authority: pool.to_account_info(),
            },
            &[pool_seeds],
        ),
        tokens_for_raydium,
    )?;
    msg!("Transferred {} tokens to payer ATA", tokens_for_raydium);

    // ── Rent reimbursement: SOL vault → payer (as plain SOL) ────────────
    invoke_signed(
        &system_instruction::transfer(
            ctx.accounts.sol_vault.key,
            ctx.accounts.payer.key,
            rent_reimbursement,
        ),
        &[
            ctx.accounts.sol_vault.to_account_info(),
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[vault_seeds],
    )?;
    msg!("Reimbursed {} lamports to payer for Raydium rent", rent_reimbursement);

    // ── Pre-wrap: remaining SOL → payer WSOL ATA ─────────────────────────
    // Transfer remaining SOL from vault to payer's WSOL ATA, then sync_native.
    invoke_signed(
        &system_instruction::transfer(
            ctx.accounts.sol_vault.key,
            ctx.accounts.payer_wsol_ata.to_account_info().key,
            sol_for_wsol,
        ),
        &[
            ctx.accounts.sol_vault.to_account_info(),
            ctx.accounts.payer_wsol_ata.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[vault_seeds],
    )?;
    token::sync_native(CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        token::SyncNative { account: ctx.accounts.payer_wsol_ata.to_account_info() },
    ))?;
    msg!("Wrapped {} lamports to WSOL in payer ATA", sol_for_wsol);

    // ── CPI to Raydium ──────────────────────────────────────
    // Payer (wallet keypair, no data) is the Raydium creator.
    // Payer signed the original tx, so their signature propagates through the CPI.
    let open_time = Clock::get()?.unix_timestamp as u64 + 1;

    if config.raydium_permission_enabled {
        msg!("PATH A: initialize_with_permission");
        let ix = raydium_cpi::build_initialize_with_permission_ix(
            ctx.accounts.raydium_program.key(),
            ctx.accounts.payer.key(),   // payer = creator
            ctx.accounts.payer.key(),   // payer = pool_creator
            ctx.accounts.raydium_amm_config.key(),
            ctx.accounts.raydium_authority.key(),
            ctx.accounts.raydium_pool_state.key(),
            token_0_mint_info.key(),
            token_1_mint_info.key(),
            ctx.accounts.raydium_lp_mint.key(),
            creator_token_0_info.key(),
            creator_token_1_info.key(),
            ctx.accounts.lp_token_account.key(),
            vault_0_info.key(),
            vault_1_info.key(),
            ctx.accounts.create_pool_fee.key(),
            ctx.accounts.raydium_observation.key(),
            ctx.accounts.raydium_permission.key(),
            ctx.accounts.token_program.key(),
            ctx.accounts.token_program.key(),
            ctx.accounts.token_program.key(),
            ctx.accounts.associated_token_program.key(),
            ctx.accounts.system_program.key(),
            init_amount_0,
            init_amount_1,
            open_time,
            raydium_cpi::RaydiumCreatorFeeOn::BothToken,
        );
        invoke(
            &ix,
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.payer.to_account_info(),   // pool_creator = payer
                ctx.accounts.raydium_amm_config.to_account_info(),
                ctx.accounts.raydium_authority.to_account_info(),
                ctx.accounts.raydium_pool_state.to_account_info(),
                token_0_mint_info.clone(),
                token_1_mint_info.clone(),
                ctx.accounts.raydium_lp_mint.to_account_info(),
                creator_token_0_info.clone(),
                creator_token_1_info.clone(),
                ctx.accounts.lp_token_account.to_account_info(),
                vault_0_info.clone(),
                vault_1_info.clone(),
                ctx.accounts.create_pool_fee.to_account_info(),
                ctx.accounts.raydium_observation.to_account_info(),
                ctx.accounts.raydium_permission.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.associated_token_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
    } else {
        msg!("PATH B: standard initialize");
        let ix = raydium_cpi::build_initialize_ix(
            ctx.accounts.raydium_program.key(),
            ctx.accounts.payer.key(),   // payer = creator
            ctx.accounts.raydium_amm_config.key(),
            ctx.accounts.raydium_authority.key(),
            ctx.accounts.raydium_pool_state.key(),
            token_0_mint_info.key(),
            token_1_mint_info.key(),
            ctx.accounts.raydium_lp_mint.key(),
            creator_token_0_info.key(),
            creator_token_1_info.key(),
            ctx.accounts.lp_token_account.key(),
            vault_0_info.key(),
            vault_1_info.key(),
            ctx.accounts.create_pool_fee.key(),
            ctx.accounts.raydium_observation.key(),
            ctx.accounts.token_program.key(),
            ctx.accounts.token_program.key(),
            ctx.accounts.token_program.key(),
            ctx.accounts.associated_token_program.key(),
            ctx.accounts.system_program.key(),
            ctx.accounts.rent.to_account_info().key(),
            init_amount_0,
            init_amount_1,
            open_time,
        );
        invoke(
            &ix,
            &[
                ctx.accounts.payer.to_account_info(),   // creator
                ctx.accounts.raydium_amm_config.to_account_info(),
                ctx.accounts.raydium_authority.to_account_info(),
                ctx.accounts.raydium_pool_state.to_account_info(),
                token_0_mint_info.clone(),
                token_1_mint_info.clone(),
                ctx.accounts.raydium_lp_mint.to_account_info(),
                creator_token_0_info.clone(),
                creator_token_1_info.clone(),
                ctx.accounts.lp_token_account.to_account_info(),
                vault_0_info.clone(),
                vault_1_info.clone(),
                ctx.accounts.create_pool_fee.to_account_info(),
                ctx.accounts.raydium_observation.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.associated_token_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.rent.to_account_info(),
            ],
        )?;
    }
    msg!("Raydium pool created");

    // ── Burn LP tokens ──────────────────────────────────────
    // Raydium sent LP tokens to payer's LP ATA. Burn them permanently.
    // Payer is authority of lp_token_account and already signed the tx.
    let lp_data = ctx.accounts.lp_token_account.try_borrow_data()?;
    let lp_amount = if lp_data.len() >= 72 {
        u64::from_le_bytes(lp_data[64..72].try_into().unwrap())
    } else { 0 };
    drop(lp_data);

    if lp_amount > 0 {
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.raydium_lp_mint.to_account_info(),
                    from: ctx.accounts.lp_token_account.to_account_info(),
                    authority: ctx.accounts.payer.to_account_info(),
                },
            ),
            lp_amount,
        )?;
        msg!("Burned {} LP tokens (permanent liquidity)", lp_amount);
    }

    // ── Mark pool graduated ─────────────────────────────────
    pool.status = PoolStatus::Graduated;
    pool.graduated_at = Clock::get()?.unix_timestamp;
    pool.raydium_pool = ctx.accounts.raydium_pool_state.key();
    pool.raydium_lp_mint = ctx.accounts.raydium_lp_mint.key();
    pool.lp_tokens_locked = lp_amount;
    pool.raydium_fees_claimed_token_0 = 0;
    pool.raydium_fees_claimed_token_1 = 0;
    pool.real_sol_balance = total_unclaimed_fees;
    pool.real_token_balance = 0;

    let config = &mut ctx.accounts.config;
    config.tokens_graduated = config.tokens_graduated
        .checked_add(1).ok_or(CurveError::MathOverflow)?;

    emit!(PoolGraduated {
        pool: pool.key(),
        mint: pool.mint,
        creator: pool.creator,
        sol_to_raydium: sol_for_wsol,
        tokens_to_raydium: tokens_for_raydium,
        tokens_burned: tokens_to_burn,
        total_volume: pool.total_volume_sol,
        total_trades: pool.total_trades,
        lifetime_creator_fees: pool.creator_fees_earned,
        lifetime_platform_fees: pool.platform_fees_earned,
        permission_mode: config.raydium_permission_enabled,
    });

    Ok(())
}

#[event]
pub struct PoolGraduated {
    pub pool: Pubkey,
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub sol_to_raydium: u64,
    pub tokens_to_raydium: u64,
    pub tokens_burned: u64,
    pub total_volume: u64,
    pub total_trades: u64,
    pub lifetime_creator_fees: u64,
    pub lifetime_platform_fees: u64,
    pub permission_mode: bool,
}
