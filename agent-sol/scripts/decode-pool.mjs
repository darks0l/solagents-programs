import { Buffer } from 'buffer';

const b64 = '1dLjvzCq3nLFGJ7tXcFkjmhsxzwbqo+NRWDBWNUTBURria1VeyoSMyVlZQ+OaH/oVenkIRKWwmmWEZy3GfcXGKl8SQHEl0ATl4toPQgAAAAg1cPVAqDDC+j0H0wBAAAAINXD1QKgwwsAAGSns7bgDQBLfJEQAAAAAIsu0AwAAAAAkccZBwAAAAAAAAAAAAAAAICP9fcCAAAA4AhltgAo8ARTX8VpAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKlBc58EAAAAFwAAAAAAAAAHAAAARGFya3NvbAQAAABEQVJLFQAAAGh0dHBzOi8vc29sYWdlbnRzLmRldv76AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const data = Buffer.from(b64, 'base64');
const d = data.subarray(8); // skip discriminator

let off = 0;

// mint: Pubkey (32)
console.log('mint:', Buffer.from(d.subarray(off, off+32)).toString('hex'));
off += 32;

// creator: Pubkey (32)
console.log('creator:', Buffer.from(d.subarray(off, off+32)).toString('hex'));
off += 32;

const readU64 = (o) => d.readBigUInt64LE(o);
const readI64 = (o) => d.readBigInt64LE(o);

// virtual_sol_reserve: u64
console.log(`virtual_sol_reserve: ${readU64(off)} (${(Number(readU64(off)) / 1e9).toFixed(4)} SOL)`);
off += 8;

// virtual_token_reserve: u64
console.log(`virtual_token_reserve: ${readU64(off)} (${(Number(readU64(off)) / 1e9).toFixed(4)} tokens)`);
off += 8;

// real_sol_balance: u64
console.log(`real_sol_balance: ${readU64(off)} (${(Number(readU64(off)) / 1e9).toFixed(4)} SOL)`);
off += 8;

// real_token_balance: u64
console.log(`real_token_balance: ${readU64(off)} (${(Number(readU64(off)) / 1e9).toFixed(4)} tokens)`);
off += 8;

// total_supply: u64
console.log(`total_supply: ${readU64(off)} (${(Number(readU64(off)) / 1e9).toFixed(4)})`);
off += 8;

// status: u8 (enum, 1 byte in Borsh)
const status = d[off];
console.log(`status: ${status} (0=Active, 1=Graduated, 2=Paused)`);
off += 1;

// creator_fees_earned: u64
console.log(`creator_fees_earned: ${readU64(off)} (${(Number(readU64(off)) / 1e9).toFixed(6)} SOL)`);
off += 8;

// creator_fees_claimed: u64
console.log(`creator_fees_claimed: ${readU64(off)} (${(Number(readU64(off)) / 1e9).toFixed(6)} SOL)`);
off += 8;

// platform_fees_earned: u64
console.log(`platform_fees_earned: ${readU64(off)} (${(Number(readU64(off)) / 1e9).toFixed(6)} SOL)`);
off += 8;

// platform_fees_claimed: u64
console.log(`platform_fees_claimed: ${readU64(off)} (${(Number(readU64(off)) / 1e9).toFixed(6)} SOL)`);
off += 8;

// dev_buy_sol: u64
console.log(`dev_buy_sol: ${readU64(off)} (${(Number(readU64(off)) / 1e9).toFixed(4)} SOL)`);
off += 8;

// dev_buy_tokens: u64
console.log(`dev_buy_tokens: ${readU64(off)} (${(Number(readU64(off)) / 1e9).toFixed(4)} tokens)`);
off += 8;

// created_at: i64
console.log(`created_at: ${readI64(off)} (${new Date(Number(readI64(off)) * 1000).toISOString()})`);
off += 8;

// graduated_at: i64
console.log(`graduated_at: ${readI64(off)}`);
off += 8;

// raydium_pool: Pubkey (32)
off += 32;
// raydium_lp_mint: Pubkey (32)
off += 32;

// lp_tokens_locked: u64
console.log(`lp_tokens_locked: ${readU64(off)}`);
off += 8;
off += 8; // raydium_fees_claimed_token_0
off += 8; // raydium_fees_claimed_token_1

// total_volume_sol: u64
console.log(`total_volume_sol: ${readU64(off)} (${(Number(readU64(off)) / 1e9).toFixed(4)} SOL)`);
off += 8;

// total_trades: u64
console.log(`total_trades: ${readU64(off)}`);
off += 8;

// name: String (4 byte len + data)
const nameLen = d.readUInt32LE(off);
off += 4;
console.log(`name: "${d.subarray(off, off + nameLen).toString()}"`);
off += nameLen;

// symbol: String
const symLen = d.readUInt32LE(off);
off += 4;
console.log(`symbol: "${d.subarray(off, off + symLen).toString()}"`);
off += symLen;

// uri: String
const uriLen = d.readUInt32LE(off);
off += 4;
console.log(`uri: "${d.subarray(off, off + uriLen).toString()}"`);
