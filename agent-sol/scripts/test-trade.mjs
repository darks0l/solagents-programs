/**
 * Test on-chain buy and sell via chain API + deployer keypair signing
 * Syncs results back to DB after each trade
 */
import { readFileSync } from 'fs';
import { Connection, Keypair, VersionedTransaction, Transaction } from '@solana/web3.js';

const API = 'https://agent-sol-api-production.up.railway.app/api';
const MINT = 'EGP6Htc7afo65XRJ3DTxSVzHiYp2RrgFysGCHVXXVKfG';
const RPC = 'https://api.devnet.solana.com';

const keyPath = new URL('../.keys/deployer.json', import.meta.url);
const secretKey = Uint8Array.from(JSON.parse(readFileSync(keyPath, 'utf8')));
const deployer = Keypair.fromSecretKey(secretKey);
const conn = new Connection(RPC, 'confirmed');
const wallet = deployer.publicKey.toBase58();

console.log(`Wallet: ${wallet}`);

async function apiPost(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function apiGet(path) {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`API ${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function signAndSend(base64Tx) {
  const buf = Buffer.from(base64Tx, 'base64');
  let sig;
  try {
    const vtx = VersionedTransaction.deserialize(buf);
    vtx.sign([deployer]);
    sig = await conn.sendRawTransaction(vtx.serialize(), { skipPreflight: false });
  } catch (e) {
    if (e.message?.includes('sendRawTransaction') || e.message?.includes('simulate')) throw e;
    const tx = Transaction.from(buf);
    tx.sign(deployer);
    sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  }
  console.log(`  TX: ${sig}`);
  const { value } = await conn.confirmTransaction(sig, 'confirmed');
  if (value?.err) throw new Error(`TX failed: ${JSON.stringify(value.err)}`);
  console.log(`  ✅ Confirmed`);
  return sig;
}

async function syncTrade(txSignature, side) {
  try {
    await apiPost('/chain/sync/trade', { txSignature, mintAddress: MINT, traderWallet: wallet });
    console.log(`  📝 Synced to DB`);
  } catch (err) {
    console.error(`  ⚠️ Sync failed: ${err.message}`);
  }
}

const action = process.argv[2] || 'both';

// ── RESET stale data first ──
if (action === 'reset' || action === 'both' || action === 'all') {
  console.log('\n═══ RESETTING STALE DATA ═══');
  try {
    const result = await apiPost('/chain/admin/reset-token', { tokenId: 'bf69a429-c190-40b2-99f3-291f487542db' });
    console.log('  ✅ Reset:', JSON.stringify(result));
  } catch (err) {
    console.error('  Reset failed:', err.message);
  }
  await new Promise(r => setTimeout(r, 1000));
}

// ── BUY TEST ──
if (action === 'buy' || action === 'both' || action === 'all') {
  console.log('\n═══ BUY: 0.05 SOL ═══');
  try {
    const { transaction } = await apiPost('/chain/build/buy', {
      mintAddress: MINT, buyerWallet: wallet, solAmount: 0.05, slippageBps: 500,
    });
    const sig = await signAndSend(transaction);
    await new Promise(r => setTimeout(r, 2000));
    await syncTrade(sig, 'buy');
    console.log(`  🔗 https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  } catch (err) {
    console.error('  BUY FAILED:', err.message);
  }
  await new Promise(r => setTimeout(r, 3000));
}

// ── SELL TEST ──
if (action === 'sell' || action === 'both' || action === 'all') {
  console.log('\n═══ SELL: 500,000 DARK ═══');
  try {
    const rawTokens = (500_000n * 1_000_000_000n).toString();
    const { transaction } = await apiPost('/chain/build/sell', {
      mintAddress: MINT, sellerWallet: wallet, tokenAmount: rawTokens, slippageBps: 500,
    });
    const sig = await signAndSend(transaction);
    await new Promise(r => setTimeout(r, 2000));
    await syncTrade(sig, 'sell');
    console.log(`  🔗 https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  } catch (err) {
    console.error('  SELL FAILED:', err.message);
  }
}

// ── POOL STATE ──
console.log('\n═══ POOL STATE (on-chain) ═══');
try {
  const pool = await apiGet(`/chain/state/pool/${MINT}`);
  console.log(`  Token: ${pool.name} ($${pool.symbol})`);
  console.log(`  Price: ${pool.price_sol} SOL/token`);
  console.log(`  SOL Reserve: ${pool.virtual_sol_reserve}`);
  console.log(`  Token Reserve: ${pool.virtual_token_reserve}`);
  console.log(`  Total Trades: ${pool.total_trades}`);
  console.log(`  Volume: ${pool.total_volume_sol} SOL`);
  console.log(`  Creator Fees: ${pool.creator_fees_earned} SOL`);
  console.log(`  Status: ${pool.status}`);
} catch (err) {
  console.error('  Pool read failed:', err.message);
}

// ── DB STATE ──
console.log('\n═══ DB STATE ═══');
try {
  const data = await apiGet(`/tokens/bf69a429-c190-40b2-99f3-291f487542db`);
  console.log(`  Price: ${data.token.current_price}`);
  console.log(`  Volume: ${data.token.volume_24h}`);
  console.log(`  Recent trades: ${data.recentTrades?.length || 0}`);
  if (data.recentTrades?.length) {
    data.recentTrades.forEach(t => {
      console.log(`    ${t.side.toUpperCase()} | ${t.tx_signature?.substring(0, 20)}... | ${t.amount_sol} lamports`);
    });
  }
} catch (err) {
  console.error('  DB read failed:', err.message);
}
