/// Maximum total fee (creator + platform) in basis points: 10%
pub const MAX_TOTAL_FEE_BPS: u16 = 1000;

/// Default creator fee: 1.4%
pub const DEFAULT_CREATOR_FEE_BPS: u16 = 140;

/// Default platform fee: 0.6%
pub const DEFAULT_PLATFORM_FEE_BPS: u16 = 60;

/// Default graduation threshold: 85 SOL in lamports
pub const DEFAULT_GRADUATION_THRESHOLD: u64 = 85_000_000_000;

/// Default total supply: 1 billion tokens
pub const DEFAULT_TOTAL_SUPPLY: u64 = 1_000_000_000;

/// Default decimals: 9 (like SOL)
pub const DEFAULT_DECIMALS: u8 = 9;

/// Default initial virtual SOL reserve: 30 SOL in lamports
pub const DEFAULT_INITIAL_VIRTUAL_SOL: u64 = 30_000_000_000;

/// Basis points denominator
pub const BPS_DENOMINATOR: u64 = 10_000;

/// Raydium CPMM program ID (mainnet)
/// CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
pub const RAYDIUM_CPMM_PROGRAM: &str = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";

/// Metaplex Token Metadata program ID
pub const TOKEN_METADATA_PROGRAM: &str = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
