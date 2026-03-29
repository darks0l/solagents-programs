use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Mint, Token, TokenAccount, MintTo, SetAuthority};
use anchor_spl::token::spl_token::instruction::AuthorityType;
use crate::state::{CurveConfig, CurvePool, PoolStatus};
use crate::errors::CurveError;

/// Metaplex Token Metadata program ID
pub mod mpl_metadata {
    use anchor_lang::declare_id;
    declare_id!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
}

// ── Raw Metaplex instruction builders (avoids crate dependency) ──

/// CreateMetadataAccountV3 instruction discriminator = [33]
/// Borsh-serialized args: DataV2 + is_mutable (bool) + collection_details (Option)
fn build_create_metadata_v3_ix(
    metadata: Pubkey,
    mint: Pubkey,
    mint_authority: Pubkey,
    payer: Pubkey,
    update_authority: Pubkey,
    system_program: Pubkey,
    rent: Pubkey,
    name: String,
    symbol: String,
    uri: String,
) -> anchor_lang::solana_program::instruction::Instruction {
    // Borsh serialize: discriminator(1) + DataV2 + is_mutable(1) + collection_details Option(1)
    let mut data = vec![33u8]; // CreateMetadataAccountV3 discriminator

    // DataV2: name(4+len) + symbol(4+len) + uri(4+len) + seller_fee_basis_points(2)
    //         + creators(Option: 1+...) + collection(Option: 1) + uses(Option: 1)
    // name
    data.extend_from_slice(&(name.len() as u32).to_le_bytes());
    data.extend_from_slice(name.as_bytes());
    // symbol
    data.extend_from_slice(&(symbol.len() as u32).to_le_bytes());
    data.extend_from_slice(symbol.as_bytes());
    // uri
    data.extend_from_slice(&(uri.len() as u32).to_le_bytes());
    data.extend_from_slice(uri.as_bytes());
    // seller_fee_basis_points
    data.extend_from_slice(&0u16.to_le_bytes());
    // creators: None
    data.push(0);
    // collection: None
    data.push(0);
    // uses: None
    data.push(0);
    // is_mutable: true (temporarily — revoked after)
    data.push(1);
    // collection_details: None
    data.push(0);

    anchor_lang::solana_program::instruction::Instruction {
        program_id: mpl_metadata::ID,
        accounts: vec![
            anchor_lang::solana_program::instruction::AccountMeta::new(metadata, false),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(mint, false),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(mint_authority, true),
            anchor_lang::solana_program::instruction::AccountMeta::new(payer, true),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(update_authority, false),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(system_program, false),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(rent, false),
        ],
        data,
    }
}

/// UpdateMetadataAccountV2 instruction discriminator = [15]
/// Sets is_mutable to false (makes metadata immutable = revokes update authority)
fn build_update_metadata_v2_ix(
    metadata: Pubkey,
    update_authority: Pubkey,
) -> anchor_lang::solana_program::instruction::Instruction {
    // discriminator(1) + data(Option: 1=None) + new_update_authority(Option: 1=None)
    // + primary_sale_happened(Option: 1=None) + is_mutable(Option: 1+1)
    let data = vec![
        15u8, // UpdateMetadataAccountV2 discriminator
        0,    // data: None
        0,    // new_update_authority: None
        0,    // primary_sale_happened: None
        1,    // is_mutable: Some(...)
        0,    // false — makes metadata immutable
    ];

    anchor_lang::solana_program::instruction::Instruction {
        program_id: mpl_metadata::ID,
        accounts: vec![
            anchor_lang::solana_program::instruction::AccountMeta::new(metadata, false),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(update_authority, true),
        ],
        data,
    }
}

#[derive(Accounts)]
#[instruction(name: String, symbol: String, uri: String)]
pub struct CreateToken<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        mut,
        seeds = [CurveConfig::SEED],
        bump = config.bump,
        constraint = !config.paused @ CurveError::CreationPaused,
    )]
    pub config: Account<'info, CurveConfig>,

    /// The SPL token mint — created here
    #[account(
        init,
        payer = creator,
        mint::decimals = config.decimals,
        mint::authority = pool,
        mint::freeze_authority = pool,
    )]
    pub mint: Account<'info, Mint>,

    /// Bonding curve pool PDA
    #[account(
        init,
        payer = creator,
        space = 8 + CurvePool::INIT_SPACE,
        seeds = [CurvePool::SEED, mint.key().as_ref()],
        bump,
    )]
    pub pool: Account<'info, CurvePool>,

    /// SOL vault PDA (holds real SOL from trades)
    /// CHECK: PDA that holds SOL, validated by seeds
    #[account(
        mut,
        seeds = [CurvePool::VAULT_SEED, pool.key().as_ref()],
        bump,
    )]
    pub sol_vault: SystemAccount<'info>,

    /// Token vault (holds pool's tokens)
    #[account(
        init,
        payer = creator,
        token::mint = mint,
        token::authority = pool,
        seeds = [CurvePool::TOKEN_VAULT_SEED, pool.key().as_ref()],
        bump,
    )]
    pub token_vault: Account<'info, TokenAccount>,

    /// Metaplex metadata account
    /// CHECK: Created via CPI to Metaplex, validated by seeds
    #[account(
        mut,
        seeds = [
            b"metadata",
            mpl_metadata::ID.as_ref(),
            mint.key().as_ref(),
        ],
        bump,
        seeds::program = mpl_metadata::ID,
    )]
    pub metadata: UncheckedAccount<'info>,

    /// Metaplex Token Metadata program
    /// CHECK: Validated by address constraint
    #[account(address = mpl_metadata::ID)]
    pub metadata_program: UncheckedAccount<'info>,

    /// Creator's token account (ATA) — needed for dev buy
    /// CHECK: Only used if dev_buy_sol > 0, validated in handler
    #[account(mut)]
    pub creator_token_account: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<CreateToken>,
    name: String,
    symbol: String,
    uri: String,
    dev_buy_sol: Option<u64>,
) -> Result<()> {
    require!(name.len() <= 32, CurveError::NameTooLong);
    require!(symbol.len() <= 10, CurveError::SymbolTooLong);
    require!(uri.len() <= 200, CurveError::UriTooLong);

    let config = &ctx.accounts.config;
    let total_supply_raw = config.total_supply
        .checked_mul(10u64.pow(config.decimals as u32))
        .ok_or(CurveError::MathOverflow)?;

    let initial_virtual_token = total_supply_raw;
    let initial_virtual_sol = config.initial_virtual_sol;

    // ── Initialize pool state ───────────────────────────────
    let pool = &mut ctx.accounts.pool;
    pool.mint = ctx.accounts.mint.key();
    pool.creator = ctx.accounts.creator.key();
    pool.virtual_sol_reserve = initial_virtual_sol;
    pool.virtual_token_reserve = initial_virtual_token;
    pool.real_sol_balance = 0;
    pool.real_token_balance = total_supply_raw;
    pool.total_supply = total_supply_raw;
    pool.status = PoolStatus::Active;
    pool.creator_fees_earned = 0;
    pool.creator_fees_claimed = 0;
    pool.platform_fees_earned = 0;
    pool.platform_fees_claimed = 0;
    pool.dev_buy_sol = 0;
    pool.dev_buy_tokens = 0;
    pool.created_at = Clock::get()?.unix_timestamp;
    pool.graduated_at = 0;
    pool.total_volume_sol = 0;
    pool.total_trades = 0;
    pool.name = name.clone();
    pool.symbol = symbol.clone();
    pool.uri = uri.clone();
    pool.bump = ctx.bumps.pool;
    pool.vault_bump = ctx.bumps.sol_vault;

    // ── Mint total supply to token vault ────────────────────
    let mint_key = ctx.accounts.mint.key();
    let pool_seeds: &[&[u8]] = &[
        CurvePool::SEED,
        mint_key.as_ref(),
        &[pool.bump],
    ];

    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.token_vault.to_account_info(),
                authority: pool.to_account_info(),
            },
            &[pool_seeds],
        ),
        total_supply_raw,
    )?;

    // ── Create Metaplex metadata (raw CPI) ──────────────────
    let create_metadata_ix = build_create_metadata_v3_ix(
        ctx.accounts.metadata.key(),
        ctx.accounts.mint.key(),
        pool.key(),   // mint authority (pool PDA)
        ctx.accounts.creator.key(),
        pool.key(),   // update authority (pool PDA)
        ctx.accounts.system_program.key(),
        ctx.accounts.rent.key(),
        name.clone(),
        symbol.clone(),
        uri.clone(),
    );

    anchor_lang::solana_program::program::invoke_signed(
        &create_metadata_ix,
        &[
            ctx.accounts.metadata.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            pool.to_account_info(),
            ctx.accounts.creator.to_account_info(),
            pool.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.rent.to_account_info(),
        ],
        &[pool_seeds],
    )?;

    // ── Revoke mint authority ───────────────────────────────
    token::set_authority(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            SetAuthority {
                current_authority: pool.to_account_info(),
                account_or_mint: ctx.accounts.mint.to_account_info(),
            },
            &[pool_seeds],
        ),
        AuthorityType::MintTokens,
        None,
    )?;

    // ── Revoke freeze authority ─────────────────────────────
    token::set_authority(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            SetAuthority {
                current_authority: pool.to_account_info(),
                account_or_mint: ctx.accounts.mint.to_account_info(),
            },
            &[pool_seeds],
        ),
        AuthorityType::FreezeAccount,
        None,
    )?;

    // ── Revoke metadata update authority ────────────────────
    let update_metadata_ix = build_update_metadata_v2_ix(
        ctx.accounts.metadata.key(),
        pool.key(),
    );

    anchor_lang::solana_program::program::invoke_signed(
        &update_metadata_ix,
        &[
            ctx.accounts.metadata.to_account_info(),
            pool.to_account_info(),
        ],
        &[pool_seeds],
    )?;

    // ── Increment tokens created ────────────────────────────
    let config = &mut ctx.accounts.config;
    config.tokens_created = config.tokens_created.checked_add(1).ok_or(CurveError::MathOverflow)?;

    // ── Handle optional dev buy ─────────────────────────────
    if let Some(dev_sol) = dev_buy_sol {
        if dev_sol > 0 {
            let total_fee_bps = config.creator_fee_bps as u64 + config.platform_fee_bps as u64;
            let fee = dev_sol.checked_mul(total_fee_bps).ok_or(CurveError::MathOverflow)?
                .checked_div(10_000).ok_or(CurveError::MathOverflow)?;
            let sol_after_fee = dev_sol.checked_sub(fee).ok_or(CurveError::MathOverflow)?;

            let pool = &mut ctx.accounts.pool;
            let tokens_out = pool.calculate_buy(sol_after_fee)
                .ok_or(CurveError::MathOverflow)?;

            require!(tokens_out > 0, CurveError::ZeroAmount);
            require!(tokens_out <= pool.real_token_balance, CurveError::ExceedsPoolBalance);

            // Transfer SOL from creator to vault
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.creator.to_account_info(),
                        to: ctx.accounts.sol_vault.to_account_info(),
                    },
                ),
                dev_sol,
            )?;

            // Split fee
            let creator_fee = fee.checked_mul(config.creator_fee_bps as u64).ok_or(CurveError::MathOverflow)?
                .checked_div(total_fee_bps).ok_or(CurveError::MathOverflow)?;
            let platform_fee = fee.checked_sub(creator_fee).ok_or(CurveError::MathOverflow)?;

            // Transfer tokens from vault to creator's token account
            let mint_key = pool.mint;
            let pool_seeds: &[&[u8]] = &[
                CurvePool::SEED,
                mint_key.as_ref(),
                &[pool.bump],
            ];

            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    token::Transfer {
                        from: ctx.accounts.token_vault.to_account_info(),
                        to: ctx.accounts.creator_token_account.to_account_info(),
                        authority: pool.to_account_info(),
                    },
                    &[pool_seeds],
                ),
                tokens_out,
            )?;

            // Update pool state
            pool.virtual_sol_reserve = pool.virtual_sol_reserve.checked_add(sol_after_fee).ok_or(CurveError::MathOverflow)?;
            pool.virtual_token_reserve = pool.virtual_token_reserve.checked_sub(tokens_out).ok_or(CurveError::MathOverflow)?;
            pool.real_sol_balance = pool.real_sol_balance.checked_add(dev_sol).ok_or(CurveError::MathOverflow)?;
            pool.real_token_balance = pool.real_token_balance.checked_sub(tokens_out).ok_or(CurveError::MathOverflow)?;
            pool.dev_buy_sol = dev_sol;
            pool.dev_buy_tokens = tokens_out;
            pool.creator_fees_earned = creator_fee;
            pool.platform_fees_earned = platform_fee;
            pool.total_volume_sol = dev_sol;
            pool.total_trades = 1;
        }
    }

    emit!(TokenCreated {
        mint: ctx.accounts.mint.key(),
        creator: ctx.accounts.creator.key(),
        name,
        symbol,
        uri,
        total_supply: total_supply_raw,
        initial_virtual_sol,
        initial_virtual_token,
        dev_buy_sol: dev_buy_sol.unwrap_or(0),
    });

    Ok(())
}

#[event]
pub struct TokenCreated {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub total_supply: u64,
    pub initial_virtual_sol: u64,
    pub initial_virtual_token: u64,
    pub dev_buy_sol: u64,
}
