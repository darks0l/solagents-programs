use anchor_lang::prelude::*;
use crate::state::PlatformConfig;
use crate::errors::CommerceError;

/// Update the accepted payment mint. Admin only.
/// Allows switching the SPL token used for job escrows (e.g., switching USDC mints on devnet).
/// Existing funded jobs remain unaffected — they already hold tokens in their vault.
#[derive(Accounts)]
pub struct SetPaymentMint<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        constraint = config.admin == admin.key() @ CommerceError::UnauthorizedClient,
    )]
    pub config: Account<'info, PlatformConfig>,

    /// The new SPL token mint for payments.
    /// CHECK: We just store the pubkey; validated when used in token operations.
    pub new_payment_mint: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<SetPaymentMint>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let old_mint = config.payment_mint;
    let new_mint = ctx.accounts.new_payment_mint.key();

    config.payment_mint = new_mint;

    emit!(PaymentMintUpdated {
        old_mint,
        new_mint,
        updated_by: ctx.accounts.admin.key(),
    });

    msg!(
        "Payment mint updated: {} -> {}",
        old_mint, new_mint
    );
    Ok(())
}

#[event]
pub struct PaymentMintUpdated {
    pub old_mint: Pubkey,
    pub new_mint: Pubkey,
    pub updated_by: Pubkey,
}
