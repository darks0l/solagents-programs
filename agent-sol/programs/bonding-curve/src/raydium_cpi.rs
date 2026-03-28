//! Raw CPI helpers for Raydium CPMM program.
//!
//! We construct instructions manually rather than importing the full Raydium crate
//! to avoid Solana SDK version conflicts. These match the on-chain Raydium CPMM
//! program at CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C (mainnet).
//!
//! Devnet: DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};

/// Raydium CPMM program ID
#[cfg(feature = "devnet")]
pub const RAYDIUM_CPMM_PROGRAM: Pubkey = pubkey!("DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb");
#[cfg(not(feature = "devnet"))]
pub const RAYDIUM_CPMM_PROGRAM: Pubkey = pubkey!("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");

/// Raydium create_pool_fee receiver
#[cfg(feature = "devnet")]
pub const CREATE_POOL_FEE_RECEIVER: Pubkey = pubkey!("3oE58BKVt8KuYkGxx8zBojugnymWmBiyafWgMrnb6eYy");
#[cfg(not(feature = "devnet"))]
pub const CREATE_POOL_FEE_RECEIVER: Pubkey = pubkey!("DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8");

/// Raydium pool seed constants
pub const RAYDIUM_AUTH_SEED: &[u8] = b"vault_and_lp_mint_auth_seed";
pub const RAYDIUM_POOL_SEED: &[u8] = b"pool";
pub const RAYDIUM_POOL_LP_MINT_SEED: &[u8] = b"pool_lp_mint";
pub const RAYDIUM_POOL_VAULT_SEED: &[u8] = b"pool_vault";
pub const RAYDIUM_OBSERVATION_SEED: &[u8] = b"observation";
pub const RAYDIUM_PERMISSION_SEED: &[u8] = b"permission";

/// CreatorFeeOn enum matching Raydium's
#[repr(u8)]
pub enum RaydiumCreatorFeeOn {
    BothToken = 0,
    OnlyToken0 = 1,
    OnlyToken1 = 2,
}

/// Anchor discriminator for `initialize` (standard, no permission required)
/// = sha256("global:initialize")[..8]
const INIT_DISC: [u8; 8] = [0xaf, 0xaf, 0x6d, 0x1f, 0x0d, 0x98, 0x9b, 0xed];

/// Anchor discriminator for `initialize_with_permission`
/// = sha256("global:initialize_with_permission")[..8]
const INIT_WITH_PERMISSION_DISC: [u8; 8] = [0x3f, 0x37, 0xfe, 0x41, 0x31, 0xb2, 0x59, 0x79];

/// Anchor discriminator for `collect_creator_fee`  
/// = sha256("global:collect_creator_fee")[..8]
const COLLECT_CREATOR_FEE_DISC: [u8; 8] = [0x14, 0x16, 0x56, 0x7b, 0xc6, 0x1c, 0xdb, 0x84];

/// Build the `initialize_with_permission` instruction for Raydium CPMM.
///
/// This creates a new Raydium pool with the caller as a permissioned creator,
/// enabling creator fee collection on all future trades.
///
/// Account order must match Raydium's InitializeWithPermission struct exactly.
#[allow(clippy::too_many_arguments)]
pub fn build_initialize_with_permission_ix(
    raydium_program: Pubkey,
    payer: Pubkey,
    creator: Pubkey,           // Our pool PDA — will be pool_creator
    amm_config: Pubkey,
    authority: Pubkey,         // Raydium auth PDA
    pool_state: Pubkey,
    token_0_mint: Pubkey,
    token_1_mint: Pubkey,
    lp_mint: Pubkey,
    payer_token_0: Pubkey,
    payer_token_1: Pubkey,
    payer_lp_token: Pubkey,
    token_0_vault: Pubkey,
    token_1_vault: Pubkey,
    create_pool_fee: Pubkey,
    observation_state: Pubkey,
    permission: Pubkey,
    token_program: Pubkey,
    token_0_program: Pubkey,
    token_1_program: Pubkey,
    associated_token_program: Pubkey,
    system_program: Pubkey,
    // Args
    init_amount_0: u64,
    init_amount_1: u64,
    open_time: u64,
    creator_fee_on: RaydiumCreatorFeeOn,
) -> Instruction {
    // Serialize instruction data: discriminator + args
    let mut data = Vec::with_capacity(8 + 8 + 8 + 8 + 1);
    data.extend_from_slice(&INIT_WITH_PERMISSION_DISC);
    data.extend_from_slice(&init_amount_0.to_le_bytes());
    data.extend_from_slice(&init_amount_1.to_le_bytes());
    data.extend_from_slice(&open_time.to_le_bytes());
    data.push(creator_fee_on as u8);

    let accounts = vec![
        AccountMeta::new(payer, true),
        AccountMeta::new_readonly(creator, false),  // Our PDA as creator
        AccountMeta::new_readonly(amm_config, false),
        AccountMeta::new_readonly(authority, false),
        AccountMeta::new(pool_state, false),
        AccountMeta::new_readonly(token_0_mint, false),
        AccountMeta::new_readonly(token_1_mint, false),
        AccountMeta::new(lp_mint, false),
        AccountMeta::new(payer_token_0, true),
        AccountMeta::new(payer_token_1, true),
        AccountMeta::new(payer_lp_token, false),
        AccountMeta::new(token_0_vault, false),
        AccountMeta::new(token_1_vault, false),
        AccountMeta::new(create_pool_fee, false),
        AccountMeta::new(observation_state, false),
        AccountMeta::new_readonly(permission, false),
        AccountMeta::new_readonly(token_program, false),
        AccountMeta::new_readonly(token_0_program, false),
        AccountMeta::new_readonly(token_1_program, false),
        AccountMeta::new_readonly(associated_token_program, false),
        AccountMeta::new_readonly(system_program, false),
    ];

    Instruction {
        program_id: raydium_program,
        accounts,
        data,
    }
}

/// Build the standard `initialize` instruction for Raydium CPMM.
///
/// This creates a pool WITHOUT creator fee privileges. Anyone can call this.
/// Used as fallback when we don't have a Raydium Permission PDA.
/// The pool will use only the AmmConfig's trade/protocol/fund fees.
#[allow(clippy::too_many_arguments)]
pub fn build_initialize_ix(
    raydium_program: Pubkey,
    creator: Pubkey,           // Payer — our pool PDA or payer
    amm_config: Pubkey,
    authority: Pubkey,         // Raydium auth PDA
    pool_state: Pubkey,
    token_0_mint: Pubkey,
    token_1_mint: Pubkey,
    lp_mint: Pubkey,
    creator_token_0: Pubkey,
    creator_token_1: Pubkey,
    creator_lp_token: Pubkey,
    token_0_vault: Pubkey,
    token_1_vault: Pubkey,
    create_pool_fee: Pubkey,
    observation_state: Pubkey,
    token_program: Pubkey,
    token_0_program: Pubkey,
    token_1_program: Pubkey,
    associated_token_program: Pubkey,
    system_program: Pubkey,
    rent: Pubkey,
    // Args
    init_amount_0: u64,
    init_amount_1: u64,
    open_time: u64,
) -> Instruction {
    let mut data = Vec::with_capacity(8 + 8 + 8 + 8);
    data.extend_from_slice(&INIT_DISC);
    data.extend_from_slice(&init_amount_0.to_le_bytes());
    data.extend_from_slice(&init_amount_1.to_le_bytes());
    data.extend_from_slice(&open_time.to_le_bytes());

    let accounts = vec![
        AccountMeta::new(creator, true),
        AccountMeta::new_readonly(amm_config, false),
        AccountMeta::new_readonly(authority, false),
        AccountMeta::new(pool_state, false),
        AccountMeta::new_readonly(token_0_mint, false),
        AccountMeta::new_readonly(token_1_mint, false),
        AccountMeta::new(lp_mint, false),
        AccountMeta::new(creator_token_0, true),
        AccountMeta::new(creator_token_1, true),
        AccountMeta::new(creator_lp_token, false),
        AccountMeta::new(token_0_vault, false),
        AccountMeta::new(token_1_vault, false),
        AccountMeta::new(create_pool_fee, false),
        AccountMeta::new(observation_state, false),
        AccountMeta::new_readonly(token_program, false),
        AccountMeta::new_readonly(token_0_program, false),
        AccountMeta::new_readonly(token_1_program, false),
        AccountMeta::new_readonly(associated_token_program, false),
        AccountMeta::new_readonly(system_program, false),
        AccountMeta::new_readonly(rent, false),
    ];

    Instruction {
        program_id: raydium_program,
        accounts,
        data,
    }
}

/// Build the `collect_creator_fee` instruction for Raydium CPMM.
///
/// The `creator` must be a signer matching `pool_state.pool_creator`.
/// When our PDA is the pool_creator, we use invoke_signed with the PDA seeds.
pub fn build_collect_creator_fee_ix(
    raydium_program: Pubkey,
    creator: Pubkey,           // Our pool PDA — must sign via invoke_signed
    authority: Pubkey,         // Raydium auth PDA
    pool_state: Pubkey,
    amm_config: Pubkey,
    token_0_vault: Pubkey,
    token_1_vault: Pubkey,
    vault_0_mint: Pubkey,
    vault_1_mint: Pubkey,
    creator_token_0: Pubkey,   // Receives agent token fees
    creator_token_1: Pubkey,   // Receives WSOL fees
    token_0_program: Pubkey,
    token_1_program: Pubkey,
    associated_token_program: Pubkey,
    system_program: Pubkey,
) -> Instruction {
    let data = COLLECT_CREATOR_FEE_DISC.to_vec();

    let accounts = vec![
        AccountMeta::new(creator, true),  // Must sign — our PDA signs via invoke_signed
        AccountMeta::new_readonly(authority, false),
        AccountMeta::new(pool_state, false),
        AccountMeta::new_readonly(amm_config, false),
        AccountMeta::new(token_0_vault, false),
        AccountMeta::new(token_1_vault, false),
        AccountMeta::new_readonly(vault_0_mint, false),
        AccountMeta::new_readonly(vault_1_mint, false),
        AccountMeta::new(creator_token_0, false),
        AccountMeta::new(creator_token_1, false),
        AccountMeta::new_readonly(token_0_program, false),
        AccountMeta::new_readonly(token_1_program, false),
        AccountMeta::new_readonly(associated_token_program, false),
        AccountMeta::new_readonly(system_program, false),
    ];

    Instruction {
        program_id: raydium_program,
        accounts,
        data,
    }
}

/// Invoke Raydium's collect_creator_fee via CPI with PDA signer.
///
/// This is the main entry point for claiming Raydium creator fees.
/// The pool PDA signs as the creator since it was set as pool_creator
/// during initialize_with_permission.
#[allow(clippy::too_many_arguments)]
pub fn invoke_collect_creator_fee<'info>(
    raydium_program: &AccountInfo<'info>,
    pool_pda: &AccountInfo<'info>,        // Our pool PDA (the creator)
    raydium_authority: &AccountInfo<'info>,
    raydium_pool_state: &AccountInfo<'info>,
    raydium_amm_config: &AccountInfo<'info>,
    token_0_vault: &AccountInfo<'info>,
    token_1_vault: &AccountInfo<'info>,
    vault_0_mint: &AccountInfo<'info>,
    vault_1_mint: &AccountInfo<'info>,
    creator_token_0: &AccountInfo<'info>,
    creator_token_1: &AccountInfo<'info>,
    token_0_program: &AccountInfo<'info>,
    token_1_program: &AccountInfo<'info>,
    associated_token_program: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    pool_seeds: &[&[u8]],
) -> Result<()> {
    let ix = build_collect_creator_fee_ix(
        raydium_program.key(),
        pool_pda.key(),
        raydium_authority.key(),
        raydium_pool_state.key(),
        raydium_amm_config.key(),
        token_0_vault.key(),
        token_1_vault.key(),
        vault_0_mint.key(),
        vault_1_mint.key(),
        creator_token_0.key(),
        creator_token_1.key(),
        token_0_program.key(),
        token_1_program.key(),
        associated_token_program.key(),
        system_program.key(),
    );

    invoke_signed(
        &ix,
        &[
            pool_pda.clone(),
            raydium_authority.clone(),
            raydium_pool_state.clone(),
            raydium_amm_config.clone(),
            token_0_vault.clone(),
            token_1_vault.clone(),
            vault_0_mint.clone(),
            vault_1_mint.clone(),
            creator_token_0.clone(),
            creator_token_1.clone(),
            token_0_program.clone(),
            token_1_program.clone(),
            associated_token_program.clone(),
            system_program.clone(),
        ],
        &[pool_seeds],
    )?;

    Ok(())
}
