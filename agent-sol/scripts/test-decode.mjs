import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { Connection, PublicKey } from '@solana/web3.js';

const require = createRequire(import.meta.url);
const { BorshCoder, Program, AnchorProvider } = require('@coral-xyz/anchor');

const idl = JSON.parse(readFileSync('./api/idl/bonding_curve.json', 'utf8'));

console.log('IDL loaded, accounts:', idl.accounts?.map(a => a.name));
console.log('IDL address:', idl.address);

// Test 1: BorshCoder directly
const coder = new BorshCoder(idl);
console.log('Coder created OK');

// Fetch from devnet and decode
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
const poolAddr = new PublicKey('ESyemXRK1gBiKmyybydf6NxMMMLxVHAc9MAkGKR6hfPA');

const info = await conn.getAccountInfo(poolAddr);
if (!info) {
  console.error('Account not found on devnet!');
  process.exit(1);
}
console.log('Account found, data length:', info.data.length, 'owner:', info.owner.toBase58());

try {
  const decoded = coder.accounts.decode('CurvePool', info.data);
  console.log('SUCCESS:', JSON.stringify({
    name: decoded.name,
    symbol: decoded.symbol,
    status: decoded.status,
    virtualSolReserve: decoded.virtualSolReserve?.toString(),
    virtualTokenReserve: decoded.virtualTokenReserve?.toString(),
  }, null, 2));
} catch (err) {
  console.error('DECODE ERROR:', err.message);
  console.error(err.stack);
}

// Test 2: Via Program
console.log('\n--- Testing via Program ---');
const provider = new AnchorProvider(conn, { publicKey: PublicKey.default, signTransaction: async t => t, signAllTransactions: async t => t }, { commitment: 'confirmed' });
try {
  const prog = new Program(idl, provider);
  console.log('Program created OK');
  const pool = await prog.account.curvePool.fetch(poolAddr);
  console.log('Pool via Program:', JSON.stringify({ name: pool.name, symbol: pool.symbol }, null, 2));
} catch (err) {
  console.error('Program method error:', err.message);
}
