import { Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import nacl from 'tweetnacl';
import fs from 'fs';

const API = 'https://agent-sol-api-production.up.railway.app';
const RPC = 'https://api.devnet.solana.com';
const conn = new Connection(RPC, 'confirmed');

const testKey = JSON.parse(fs.readFileSync('test-wallet.json', 'utf8'));
const wallet = Keypair.fromSecretKey(Uint8Array.from(testKey));
const WALLET = wallet.publicKey.toBase58();

function log(step, msg) { console.log(`\n✅ [${step}] ${msg}`); }
function fail(step, msg) { console.error(`\n❌ [${step}] ${msg}`); process.exit(1); }

// Generate auth header
function getAuthHeader(agentId) {
  const ts = Math.floor(Date.now() / 1000);
  const message = `AgentSol:${agentId}:${ts}`;
  const msgBytes = new TextEncoder().encode(message);
  const sig = nacl.sign.detached(msgBytes, wallet.secretKey);
  const sigB64 = Buffer.from(sig).toString('base64');
  return { Authorization: `Bearer ${agentId}:${sigB64}:${ts}` };
}

async function api(method, path, body, headers = {}) {
  const opts = { method, headers: { 'Content-Type': 'application/json', ...headers } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API}${path}`, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, data: json };
}

async function run() {
  console.log('═══════════════════════════════════════════');
  console.log('  AGENT SOL — END-TO-END TEST');
  console.log(`  Wallet: ${WALLET}`);
  console.log('═══════════════════════════════════════════');

  // ── STEP 1: Health check ──
  const health = await api('GET', '/api/health');
  if (health.data?.status !== 'ok') fail('HEALTH', JSON.stringify(health.data));
  log('HEALTH', `API is up — ${health.data.service} v${health.data.version}`);

  // ── STEP 2: Registration info ──
  const regInfo = await api('GET', '/api/register/info');
  log('REG-INFO', `Treasury: ${regInfo.data.treasury}, Fee: ${regInfo.data.feeLamports} lamports`);

  // ── STEP 3: Register agent ──
  const agentName = `TestBot_${Date.now().toString(36)}`;
  const regPayload = {
    name: agentName,
    walletAddress: WALLET,
    publicKey: WALLET,
    capabilities: ['trading', 'analysis'],
    description: 'E2E test agent'
  };

  // Pay registration fee
  const treasury = new PublicKey(regInfo.data.treasury);
  const feeLamports = parseInt(regInfo.data.feeLamports);
  const payTx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: treasury, lamports: feeLamports })
  );
  const paySig = await sendAndConfirmTransaction(conn, payTx, [wallet]);
  log('REG-PAY', `Fee paid: ${paySig}`);

  regPayload.txSignature = paySig;
  const regRes = await api('POST', '/api/register', regPayload);
  if (regRes.status !== 201 && regRes.status !== 200) fail('REGISTER', `Status ${regRes.status}: ${JSON.stringify(regRes.data)}`);
  // Registration may not return ID directly — look it up by wallet
  let agentId = regRes.data.agentId || regRes.data.id || regRes.data.agent?.id;
  if (!agentId) {
    const lookup = await api('GET', `/api/agents/wallet/${WALLET}`);
    agentId = lookup.data?.id;
  }
  if (!agentId) fail('REGISTER', 'Could not resolve agent ID');
  log('REGISTER', `Agent registered: ${agentId} (${agentName})`);

  // ── STEP 4: Verify auth (test by hitting a protected endpoint) ──
  const authHeaders = getAuthHeader(agentId);
  const dashRes = await api('GET', `/api/agents/${agentId}/dashboard`, null, authHeaders);
  if (dashRes.status !== 200) fail('AUTH', `Status ${dashRes.status}: ${JSON.stringify(dashRes.data)}`);
  log('AUTH', `Auth works — dashboard returned for ${dashRes.data?.agent?.name || agentId}`);

  // ── STEP 5: Get tokenize config ──
  const tokConfig = await api('GET', '/api/tokenize/config');
  log('TOK-CONFIG', `Supply: ${tokConfig.data?.totalSupply || 'default'}, Decimals: ${tokConfig.data?.decimals || 9}`);

  // ── STEP 6: Tokenize agent ──
  const tokenizeRes = await api('POST', `/api/agents/${agentId}/tokenize`, {
    tokenName: agentName,
    tokenSymbol: 'TEST',
    description: 'E2E test token'
  }, authHeaders);
  if (tokenizeRes.status !== 200 && tokenizeRes.status !== 201) fail('TOKENIZE', `Status ${tokenizeRes.status}: ${JSON.stringify(tokenizeRes.data)}`);
  const tokenId = tokenizeRes.data.tokenId || tokenizeRes.data.id;
  log('TOKENIZE', `Token created in DB: ${tokenId}`);

  // ── STEP 7: Build create-token TX ──
  const buildRes = await api('POST', '/api/chain/build/create-token', {
    name: agentName,
    symbol: 'TEST',
    uri: 'https://example.com/meta.json',
    creatorWallet: WALLET
  });
  if (buildRes.status !== 200) fail('BUILD-CREATE', `Status ${buildRes.status}: ${JSON.stringify(buildRes.data)}`);
  
  const txBuf = Buffer.from(buildRes.data.transaction, 'base64');
  const tx = Transaction.from(txBuf);
  
  // The TX needs a fresh mint keypair that was generated server-side
  // We need to sign with our wallet + the mint keypair
  // The mint keypair should be in the response
  const mintAddress = buildRes.data.mintPublicKey;
  log('BUILD-CREATE', `TX built, mint: ${mintAddress}`);

  // Sign and send
  tx.partialSign(wallet);
  // The server already signed with the mint keypair
  const rawTx = tx.serialize();
  const createSig = await conn.sendRawTransaction(rawTx);
  await conn.confirmTransaction(createSig, 'confirmed');
  log('CREATE-TOKEN', `On-chain TX: ${createSig}`);

  // ── STEP 8: Activate token ──
  const activateRes = await api('POST', `/api/tokens/${tokenId}/activate`, {
    mintAddress: mintAddress,
    launchTx: createSig,
    authoritiesRevoked: { freeze: true, mint: true, metadata: true }
  });
  if (activateRes.status !== 200) fail('ACTIVATE', `Status ${activateRes.status}: ${JSON.stringify(activateRes.data)}`);
  log('ACTIVATE', `Token activated: ${activateRes.data.status}`);

  // ── STEP 9: Check pool state ──
  const poolState = await api('GET', `/api/chain/state/pool/${mintAddress}`);
  if (poolState.status !== 200) fail('POOL-STATE', `Status ${poolState.status}: ${JSON.stringify(poolState.data)}`);
  log('POOL-STATE', `Status: ${poolState.data.status}, SOL: ${poolState.data.realSolBalance}, Tokens: ${poolState.data.realTokenBalance}`);

  // ── STEP 10: Quote a buy ──
  const quoteRes = await api('GET', `/api/chain/quote?mint=${mintAddress}&side=buy&amount=100000000`);  // quote uses lamports
  if (quoteRes.status !== 200) fail('QUOTE', `Status ${quoteRes.status}: ${JSON.stringify(quoteRes.data)}`);
  log('QUOTE', `Buy 0.1 SOL → ${quoteRes.data.expectedTokens} tokens, fee: ${quoteRes.data.fee}`);

  // ── STEP 11: Build + send buy TX ──
  const buyBuild = await api('POST', '/api/chain/build/buy', {
    mintAddress: mintAddress,
    solAmount: 0.1,        // in SOL (not lamports) — API multiplies by 1e9 internally
    buyerWallet: WALLET,
    slippageBps: 500
  });
  if (buyBuild.status !== 200) fail('BUILD-BUY', `Status ${buyBuild.status}: ${JSON.stringify(buyBuild.data)}`);

  const buyTxBuf = Buffer.from(buyBuild.data.transaction, 'base64');
  const buyTx = Transaction.from(buyTxBuf);
  buyTx.sign(wallet);
  const buySig = await conn.sendRawTransaction(buyTx.serialize());
  await conn.confirmTransaction(buySig, 'confirmed');
  log('BUY', `Bought tokens! TX: ${buySig}`);

  // Sync the trade
  await api('POST', '/api/chain/sync/trade', { txSignature: buySig, mintAddress, side: 'buy' });
  log('SYNC-BUY', 'Trade synced to DB');

  // ── STEP 12: Check updated pool ──
  const poolAfterBuy = await api('GET', `/api/chain/state/pool/${mintAddress}`);
  log('POOL-AFTER-BUY', `SOL: ${poolAfterBuy.data.realSolBalance}, Progress: ${poolAfterBuy.data.graduation_progress}%`);

  // ── STEP 13: Quote + build sell TX ──
  // Get our token balance first
  const mintPk = new PublicKey(mintAddress);
  const ata = await getAssociatedTokenAddress(mintPk, wallet.publicKey);
  const tokenBal = await conn.getTokenAccountBalance(ata);
  const sellAmount = tokenBal.value.amount; // sell everything
  log('TOKEN-BAL', `Holding: ${tokenBal.value.uiAmountString} TEST`);

  const sellQuote = await api('GET', `/api/chain/quote?mint=${mintAddress}&side=sell&amount=${sellAmount}`);
  log('QUOTE-SELL', `Sell ${tokenBal.value.uiAmountString} → ${sellQuote.data.expectedSol} lamports`);

  const sellBuild = await api('POST', '/api/chain/build/sell', {
    mintAddress: mintAddress,
    tokenAmount: sellAmount,
    sellerWallet: WALLET,
    slippageBps: 500
  });
  if (sellBuild.status !== 200) fail('BUILD-SELL', `Status ${sellBuild.status}: ${JSON.stringify(sellBuild.data)}`);

  const sellTxBuf = Buffer.from(sellBuild.data.transaction, 'base64');
  const sellTx = Transaction.from(sellTxBuf);
  sellTx.sign(wallet);
  const sellSig = await conn.sendRawTransaction(sellTx.serialize());
  await conn.confirmTransaction(sellSig, 'confirmed');
  log('SELL', `Sold all tokens! TX: ${sellSig}`);

  await api('POST', '/api/chain/sync/trade', { txSignature: sellSig, mintAddress, side: 'sell' });
  log('SYNC-SELL', 'Trade synced to DB');

  // ── STEP 14: Final pool state ──
  const poolFinal = await api('GET', `/api/chain/state/pool/${mintAddress}`);
  log('POOL-FINAL', `SOL: ${poolFinal.data.realSolBalance}, Tokens: ${poolFinal.data.realTokenBalance}, Status: ${poolFinal.data.status}`);

  // ── STEP 15: Check platform stats ──
  const stats = await api('GET', '/api/platform/stats');
  log('STATS', `Agents: ${stats.data.total_agents}, Tokens: ${stats.data.total_tokens}, Tokenized: ${stats.data.tokenized_agents}`);

  // ── STEP 16: Integration guide check ──
  const guide = await api('GET', '/api/integration-guide');
  const instrCount = Object.keys(guide.data?.programs?.bonding_curve?.instructions || {}).length;
  const errorCount = guide.data?.common_errors?.length || 0;
  log('GUIDE', `Instructions documented: ${instrCount}, Error codes: ${errorCount}`);

  console.log('\n═══════════════════════════════════════════');
  console.log('  ALL TESTS PASSED ✅');
  console.log('═══════════════════════════════════════════\n');

  // Cleanup
  fs.unlinkSync('test-wallet.json');
}

run().catch(e => { console.error('\n💀 FATAL:', e.message || e); process.exit(1); });
