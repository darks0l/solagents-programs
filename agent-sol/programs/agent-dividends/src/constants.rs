/// Precision multiplier for reward_per_token calculations (1e18).
pub const PRECISION: u128 = 1_000_000_000_000_000_000;

/// Basis-point denominator (10_000 = 100%).
pub const BPS_DENOMINATOR: u64 = 10_000;

/// Mode switch cooldown: 7 days in seconds.
pub const MODE_SWITCH_COOLDOWN: i64 = 7 * 24 * 60 * 60;

// ── PDA seeds ──────────────────────────────────────────────────────────

pub const SEED_DIVIDEND_CONFIG: &[u8] = b"dividend_config";
pub const SEED_TOKEN_DIVIDEND: &[u8] = b"token_dividend";
pub const SEED_STAKE_POSITION: &[u8] = b"stake_position";
pub const SEED_STAKING_VAULT: &[u8] = b"staking_vault";
pub const SEED_DIVIDEND_VAULT: &[u8] = b"dividend_vault";
pub const SEED_BUYBACK_VAULT: &[u8] = b"buyback_vault";
