use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_instruction;
use anchor_spl::token::{self, Token, TokenAccount};
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
///
/// **Path A — Permission mode** (`config.raydium_permission_enabled = true`):
///   Uses `initialize_with_permission` to create Raydium pool.
///   - Our pool PDA becomes `pool_creator` on Raydium
///   - Enables creator fee collection on ALL post-graduation trades
///   - Fees split 50/50 via `claim_raydium_fees`
///   - Requires: Raydium Permission PDA for our wallet (admin must apply)
///
/// **Path B — Standard mode** (fallback):
///   Uses standard `initialize` to create Raydium pool.
///   - No creator fee privileges post-graduation
///   - Pool uses AmmConfig's default trade/protocol/fund fees only
///   - Revenue comes entirely from pre-graduation bonding curve fees
///   - No Permission PDA needed — works immediately
///
/// Both paths:
/// - LP tokens locked in program PDA (permanent liquidity)
/// - Pool marked as Graduated
/// - Permissionless trigger (anyone can call once threshold met)
#[derive(Accounts)]
pub struct Graduate<'info> {
    #[account(mut)]
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

    /// Token vault — remaining tokens get transferred to Raydium
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

    // ── Raydium CPMM accounts ───────────────────────────────

    /// Raydium CPMM program
    /// CHECK: Validated by address
    #[account(address = raydium_cpi::RAYDIUM_CPMM_PROGRAM)]
    pub raydium_program: UncheckedAccount<'info>,

    /// Raydium AMM config (pre-existing, determines fee structure)
    /// CHECK: Owned by Raydium program, validated in CPI
    pub raydium_amm_config: UncheckedAccount<'info>,

    /// Raydium pool state — created by CPI
    /// CHECK: Created by Raydium CPI
    #[account(mut)]
    pub raydium_pool_state: UncheckedAccount<'info>,

    /// Raydium authority PDA
    /// CHECK: Derived by Raydium program
    pub raydium_authority: UncheckedAccount<'info>,

    /// Raydium token 0 vault
    /// CHECK: Created by Raydium CPI
    #[account(mut)]
    pub raydium_token_0_vault: UncheckedAccount<'info>,

    /// Raydium token 1 vault (WSOL)
    /// CHECK: Created by Raydium CPI
    #[account(mut)]
    pub raydium_token_1_vault: UncheckedAccount<'info>,

    /// Raydium LP mint — created by CPI
    /// CHECK: Created by Raydium CPI
    #[account(mut)]
    pub raydium_lp_mint: UncheckedAccount<'info>,

    /// LP token account — receives LP tokens (locked, never withdrawn)
    /// CHECK: Created for LP locking
    #[account(mut)]
    pub lp_token_account: UncheckedAccount<'info>,

    /// Pool PDA's WSOL token account — SOL is wrapped here before Raydium deposit.
    /// Created if needed, authority = pool PDA (signs via invoke_signed).
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = wsol_mint,
        associated_token::authority = pool,
    )]
    pub wsol_ata: Account<'info, TokenAccount>,

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

    /// Raydium Permission PDA (optional — only needed for Path A).
    /// Seeds: ["permission", payer_pubkey] on Raydium program.
    /// If `config.raydium_permission_enabled` is false, this can be any account
    /// (it won't be used in the CPI).
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

    // ── Calculate amounts for Raydium pool ──────────────────
    let tokens_for_raydium = pool.real_token_balance;
    let sol_for_raydium = net_sol;

    msg!("Graduating pool: {} SOL + {} tokens to Raydium", sol_for_raydium, tokens_for_raydium);
    msg!("Unclaimed fees reserved: {} creator + {} platform", unclaimed_creator_fees, unclaimed_platform_fees);
    msg!("Permission mode: {}", config.raydium_permission_enabled);

    // Capture keys + bumps before mutable borrow of pool
    let mint_key = pool.mint;
    let pool_key = pool.key();
    let pool_bump = pool.bump;
    let vault_bump = pool.vault_bump;

    let pool_seeds: &[&[u8]] = &[
        CurvePool::SEED,
        mint_key.as_ref(),
        &[pool_bump],
    ];

    let vault_seeds: &[&[u8]] = &[
        CurvePool::VAULT_SEED,
        pool_key.as_ref(),
        &[vault_bump],
    ];

    // ── Wrap SOL → WSOL in pool's ATA ──────────────────────
    // Transfer SOL from sol_vault PDA into the pool's WSOL ATA, then sync_native
    // so the SPL token balance matches. Raydium reads the token balance, not lamports.
    invoke_signed(
        &system_instruction::transfer(
            ctx.accounts.sol_vault.key,
            ctx.accounts.wsol_ata.to_account_info().key,
            sol_for_raydium,
        ),
        &[
            ctx.accounts.sol_vault.to_account_info(),
            ctx.accounts.wsol_ata.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[vault_seeds],
    )?;

    token::sync_native(CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        token::SyncNative {
            account: ctx.accounts.wsol_ata.to_account_info(),
        },
    ))?;

    // ── Transfer tokens from vault to Raydium ───────────────
    // NOTE: token_vault already holds the agent tokens (pool's SPL token account).
    // Raydium CPI will pull from token_vault (creator_token_0) and wsol_ata (creator_token_1).

    // Token vault (token_vault) holds the agent tokens.
    // Raydium initialize CPI will pull tokens from token_vault (creator_token_0) directly —
    // we do NOT pre-transfer here; Raydium does it internally.

    // ── CPI to Raydium — dual path ──────────────────────────
    let open_time = Clock::get()?.unix_timestamp as u64 + 1;

    if config.raydium_permission_enabled {
        // ═══ PATH A: initialize_with_permission ═══
        // Creates pool with our PDA as pool_creator.
        // Enables creator fee collection on all future Raydium trades.
        msg!("PATH A: Using initialize_with_permission (creator fees enabled)");

        let ix = raydium_cpi::build_initialize_with_permission_ix(
            ctx.accounts.raydium_program.key(),
            ctx.accounts.payer.key(),
            pool_key,                                      // Our pool PDA = pool_creator
            ctx.accounts.raydium_amm_config.key(),
            ctx.accounts.raydium_authority.key(),
            ctx.accounts.raydium_pool_state.key(),
            ctx.accounts.mint.key(),                       // token 0 (agent token)
            ctx.accounts.wsol_mint.key(),                  // token 1 (WSOL)
            ctx.accounts.raydium_lp_mint.key(),
            ctx.accounts.token_vault.key(),                // payer_token_0 (pool's agent token ATA — debited)
            ctx.accounts.wsol_ata.key(),                   // payer_token_1 (pool's WSOL ATA — debited)
            ctx.accounts.lp_token_account.key(),           // payer_lp_token (receives LP tokens)
            ctx.accounts.raydium_token_0_vault.key(),      // token_0_vault (Raydium-internal, gets credited)
            ctx.accounts.raydium_token_1_vault.key(),      // token_1_vault (Raydium-internal, gets credited)
            ctx.accounts.create_pool_fee.key(),
            ctx.accounts.raydium_observation.key(),
            ctx.accounts.raydium_permission.key(),
            ctx.accounts.token_program.key(),
            ctx.accounts.token_program.key(),              // token_0_program (SPL Token)
            ctx.accounts.token_program.key(),              // token_1_program (SPL Token)
            ctx.accounts.associated_token_program.key(),
            ctx.accounts.system_program.key(),
            tokens_for_raydium,
            sol_for_raydium,
            open_time,
            raydium_cpi::RaydiumCreatorFeeOn::BothToken,
        );

        // Pool PDA signs as creator
        invoke_signed(
            &ix,
            &[
                ctx.accounts.payer.to_account_info(),
                pool.to_account_info(),
                ctx.accounts.raydium_amm_config.to_account_info(),
                ctx.accounts.raydium_authority.to_account_info(),
                ctx.accounts.raydium_pool_state.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.wsol_mint.to_account_info(),
                ctx.accounts.raydium_lp_mint.to_account_info(),
                ctx.accounts.token_vault.to_account_info(),           // payer_token_0
                ctx.accounts.wsol_ata.to_account_info(),              // payer_token_1
                ctx.accounts.lp_token_account.to_account_info(),
                ctx.accounts.raydium_token_0_vault.to_account_info(),
                ctx.accounts.raydium_token_1_vault.to_account_info(),
                ctx.accounts.create_pool_fee.to_account_info(),
                ctx.accounts.raydium_observation.to_account_info(),
                ctx.accounts.raydium_permission.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.associated_token_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[pool_seeds],
        )?;
    } else {
        // ═══ PATH B: standard initialize (fallback) ═══
        // Creates pool without creator fee privileges.
        // Revenue comes entirely from pre-graduation bonding curve fees.
        msg!("PATH B: Using standard initialize (no creator fees on Raydium)");

        let ix = raydium_cpi::build_initialize_ix(
            ctx.accounts.raydium_program.key(),
            ctx.accounts.payer.key(),
            ctx.accounts.raydium_amm_config.key(),
            ctx.accounts.raydium_authority.key(),
            ctx.accounts.raydium_pool_state.key(),
            ctx.accounts.mint.key(),                       // token 0 (agent token)
            ctx.accounts.wsol_mint.key(),                  // token 1 (WSOL)
            ctx.accounts.raydium_lp_mint.key(),
            ctx.accounts.token_vault.key(),                // creator_token_0 (pool's agent token ATA — debited)
            ctx.accounts.wsol_ata.key(),                   // creator_token_1 (pool's WSOL ATA — debited)
            ctx.accounts.lp_token_account.key(),           // creator_lp_token (receives LP tokens)
            ctx.accounts.raydium_token_0_vault.key(),      // token_0_vault (Raydium-internal)
            ctx.accounts.raydium_token_1_vault.key(),      // token_1_vault (Raydium-internal)
            ctx.accounts.create_pool_fee.key(),
            ctx.accounts.raydium_observation.key(),
            ctx.accounts.token_program.key(),
            ctx.accounts.token_program.key(),              // token_0_program
            ctx.accounts.token_program.key(),              // token_1_program
            ctx.accounts.associated_token_program.key(),
            ctx.accounts.system_program.key(),
            ctx.accounts.rent.to_account_info().key(),
            tokens_for_raydium,
            sol_for_raydium,
            open_time,
        );

        invoke_signed(
            &ix,
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.raydium_amm_config.to_account_info(),
                ctx.accounts.raydium_authority.to_account_info(),
                ctx.accounts.raydium_pool_state.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.wsol_mint.to_account_info(),
                ctx.accounts.raydium_lp_mint.to_account_info(),
                ctx.accounts.token_vault.to_account_info(),           // creator_token_0
                ctx.accounts.wsol_ata.to_account_info(),              // creator_token_1
                ctx.accounts.lp_token_account.to_account_info(),
                ctx.accounts.raydium_token_0_vault.to_account_info(),
                ctx.accounts.raydium_token_1_vault.to_account_info(),
                ctx.accounts.create_pool_fee.to_account_info(),
                ctx.accounts.raydium_observation.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.associated_token_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.rent.to_account_info(),
            ],
            &[pool_seeds],
        )?;
    }

    // ── Lock LP tokens ──────────────────────────────────────
    // After Raydium CPI, LP tokens land in lp_token_account.
    // We keep them locked — never burn, never withdraw.
    // This means: liquidity is permanent + creator fees claimable (Path A only).
    // Manually deserialize SPL token balance from account data (offset 64..72 = amount field).
    let lp_amount = {
        let lp_data = ctx.accounts.lp_token_account.try_borrow_data()?;
        if lp_data.len() >= 72 {
            u64::from_le_bytes(lp_data[64..72].try_into().unwrap())
        } else {
            0
        }
    };
    msg!("LP tokens locked in program PDA: {}", lp_amount);

    // ── Mark pool as graduated ──────────────────────────────
    pool.status = PoolStatus::Graduated;
    pool.graduated_at = Clock::get()?.unix_timestamp;
    pool.raydium_pool = ctx.accounts.raydium_pool_state.key();
    pool.raydium_lp_mint = ctx.accounts.raydium_lp_mint.key();
    pool.lp_tokens_locked = lp_amount;
    pool.raydium_fees_claimed_token_0 = 0;
    pool.raydium_fees_claimed_token_1 = 0;
    pool.real_sol_balance = total_unclaimed_fees; // Only fees remain
    pool.real_token_balance = 0;

    // ── Update global stats ─────────────────────────────────
    let config = &mut ctx.accounts.config;
    config.tokens_graduated = config.tokens_graduated
        .checked_add(1)
        .ok_or(CurveError::MathOverflow)?;

    emit!(PoolGraduated {
        pool: pool.key(),
        mint: pool.mint,
        creator: pool.creator,
        sol_to_raydium: sol_for_raydium,
        tokens_to_raydium: tokens_for_raydium,
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
    pub total_volume: u64,
    pub total_trades: u64,
    pub lifetime_creator_fees: u64,
    pub lifetime_platform_fees: u64,
    /// Whether creator fee collection was enabled on Raydium
    pub permission_mode: bool,
}
