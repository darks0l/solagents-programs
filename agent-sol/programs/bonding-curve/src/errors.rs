use anchor_lang::prelude::*;

#[error_code]
pub enum CurveError {
    #[msg("Only admin can perform this action")]
    Unauthorized,

    #[msg("Token creation is currently paused")]
    CreationPaused,

    #[msg("Pool is not active — trading disabled")]
    PoolNotActive,

    #[msg("Pool has already graduated to Raydium")]
    AlreadyGraduated,

    #[msg("Pool has not reached graduation threshold")]
    NotReadyToGraduate,

    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,

    #[msg("Insufficient SOL for this trade")]
    InsufficientSol,

    #[msg("Insufficient tokens for this trade")]
    InsufficientTokens,

    #[msg("Zero amount not allowed")]
    ZeroAmount,

    #[msg("Math overflow")]
    MathOverflow,

    #[msg("Invalid fee configuration — total fees cannot exceed 1000 bps (10%)")]
    InvalidFees,

    #[msg("Invalid graduation threshold — must be greater than 0")]
    InvalidThreshold,

    #[msg("No fees available to claim")]
    NoFeesToClaim,

    #[msg("Token name too long (max 32 chars)")]
    NameTooLong,

    #[msg("Token symbol too long (max 10 chars)")]
    SymbolTooLong,

    #[msg("Metadata URI too long (max 200 chars)")]
    UriTooLong,

    #[msg("Invalid total supply — must be greater than 0")]
    InvalidSupply,

    #[msg("Invalid decimals — must be between 0 and 9")]
    InvalidDecimals,

    #[msg("Buy would exceed remaining tokens in pool")]
    ExceedsPoolBalance,

    #[msg("Sell would exceed real SOL in pool")]
    ExceedsRealSol,

    #[msg("Creator mismatch — only the token creator can perform this action")]
    CreatorMismatch,

    #[msg("Pool has not graduated — Raydium fees only available post-graduation")]
    NotGraduated,

    #[msg("No Raydium creator fees to claim")]
    NoRaydiumFees,

    #[msg("Trading is currently paused")]
    TradingPaused,

    #[msg("No pending admin transfer")]
    NoPendingAdmin,

    #[msg("Only the pending admin can accept the transfer")]
    NotPendingAdmin,

    #[msg("Pool still has unclaimed fees — claim all fees before closing")]
    UnclaimedFees,

    #[msg("Token vault is not empty")]
    VaultNotEmpty,

    #[msg("Dev buy exceeds maximum allowed (50% of graduation threshold)")]
    DevBuyExceedsMax,

    #[msg("Self-referral not allowed — referrer cannot be the trader")]
    SelfReferral,

    #[msg("Referrals are not enabled for this token")]
    ReferralsDisabled,

    #[msg("Referral fee exceeds platform fee — must be <= platform_fee_bps")]
    ReferralFeeExceedsPlatform,
}
