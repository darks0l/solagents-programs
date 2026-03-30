use anchor_lang::prelude::*;

#[error_code]
pub enum CommerceError {
    #[msg("Job is not in the required state for this action")]
    InvalidState,

    #[msg("Only the client can perform this action")]
    UnauthorizedClient,

    #[msg("Only the provider can perform this action")]
    UnauthorizedProvider,

    #[msg("Only the evaluator can perform this action")]
    UnauthorizedEvaluator,

    #[msg("Provider is already set on this job")]
    ProviderAlreadySet,

    #[msg("Provider must be set before funding")]
    ProviderNotSet,

    #[msg("Budget must be greater than zero")]
    ZeroBudget,

    #[msg("Expected budget does not match job budget (front-running protection)")]
    BudgetMismatch,

    #[msg("Job expiration must be in the future")]
    ExpirationInPast,

    #[msg("Job has not expired yet")]
    NotExpired,

    #[msg("Job has expired")]
    Expired,

    #[msg("Evaluator address cannot be zero")]
    ZeroEvaluator,

    #[msg("Provider address cannot be zero")]
    ZeroProvider,

    #[msg("Deliverable cannot be empty")]
    EmptyDeliverable,

    #[msg("Fee basis points exceed maximum (10000 = 100%)")]
    FeeTooHigh,

    #[msg("Arithmetic overflow")]
    Overflow,

    #[msg("Hook CPI call failed")]
    HookFailed,

    #[msg("Invalid hook program")]
    InvalidHook,

    #[msg("Platform is currently paused")]
    PlatformPaused,

    #[msg("No pending admin transfer")]
    NoPendingAdmin,

    #[msg("Only the pending admin can accept the transfer")]
    NotPendingAdmin,
}
