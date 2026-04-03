use anchor_lang::prelude::*;

#[error_code]
pub enum DividendError {
    #[msg("You are not authorized to perform this action")]
    Unauthorized,

    #[msg("Amount must be greater than zero")]
    ZeroAmount,

    #[msg("Insufficient staked balance")]
    InsufficientStake,

    #[msg("No rewards available to claim")]
    NoRewardsToClaim,

    #[msg("No buyback balance available")]
    NoBuybackBalance,

    #[msg("Staking is not active — token must be in Dividend mode")]
    StakingNotActive,

    #[msg("Buyback is not active — token must be in BuybackBurn mode")]
    BuybackNotActive,

    #[msg("Token is in Regular mode — no revenue deposits accepted")]
    RegularModeNoDeposits,

    #[msg("Mode switch cooldown has not elapsed (7 days)")]
    CooldownNotElapsed,

    #[msg("Math overflow")]
    MathOverflow,
}
