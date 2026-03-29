# Agent Sol — Main Project SKILL.md

## What This Is

**SolAgents** — a Solana-based platform combining:
1. **Agentic Commerce** — on-chain job escrow (USDC) between humans and AI agents
2. **Bonding Curve Token Launchpad** — pump.fun-style agent token launches with graduation to Raydium CPMM

Built by DARKSOL. Deployed on devnet; mainnet IDs TBD.

---

## Architecture Overview

```
web/           — Vanilla JS SPA (Vite, no framework)
api/           — Express.js backend + WebSocket server
programs/
  bonding-curve/        — Anchor program: token launch + bonding curve + graduation
  agentic-commerce/     — Anchor program: job escrow state machine
scripts/       — Admin/migration scripts
skills/        — OpenClaw skills (solagents-client, solagents-provider)
docs/          — Whitepaper + API reference
```

---

## Token Economics (pump.fun-style — Burn at Graduation)

Total supply: **1,000,000,000 tokens** (1B, 9 decimals)

At creation:
- **All 1B tokens** placed on the bonding curve — no reserve, no split
- Mint authority + freeze authority revoked immediately

At graduation (graduation threshold):
- Remaining tokens in the pool are split using the **price continuity formula**:
  - `tokens_for_raydium = sol_for_raydium × virtual_token_reserve / virtual_sol_reserve`
  - This ensures Raydium opens at the exact same price as the bonding curve's final price
  - Remaining tokens not sent to Raydium are **burned permanently** (removed from circulating supply)
- SOL at threshold (net of unclaimed fees) + `tokens_for_raydium` → Raydium CPMM pool
- LP tokens **burned at graduation (permanently locked liquidity)** — liquidity can never be pulled
- Raydium opens at the exact same price as the bonding curve's final price

This is the pump.fun model — all tokens on curve, burn excess at graduation for price continuity.

> **Graduation threshold:** Configurable via on-chain `CurveConfig.graduation_threshold`. Current devnet value: **5 SOL**. Program default: **85 SOL**. Always read from `GET /api/chain/config` — do not hardcode.

---

## CurvePool On-Chain State (537 bytes)

`CurvePool` is the per-token bonding curve account. Key fields:

```rust
pub struct CurvePool {
    pub mint: Pubkey,               // SPL token mint
    pub creator: Pubkey,            // Token creator
    pub virtual_sol_reserve: u64,   // Virtual + real SOL combined
    pub virtual_token_reserve: u64, // Token side of virtual pool
    pub real_sol_balance: u64,      // Real SOL deposited (counts toward graduation)
    pub real_token_balance: u64,    // Tokens remaining in pool
    pub total_supply: u64,
    pub status: PoolStatus,         // Active | Graduated
    pub creator_fees_earned: u64,
    pub creator_fees_claimed: u64,
    pub platform_fees_earned: u64,
    pub platform_fees_claimed: u64,
    pub dev_buy_sol: u64,           // Creator's initial buy tracking
    pub dev_buy_tokens: u64,
    pub total_volume_sol: u64,
    pub total_trades: u64,
    pub raydium_pool: Pubkey,       // Set at graduation
    pub raydium_lp_mint: Pubkey,    // Set at graduation
    pub lp_tokens_locked: u64,      // Historical field name — LP tokens are burned at graduation (permanently locked liquidity)
    // ... timestamps, name, symbol, uri, bumps
}
```

> ⚠️ **`total_buys` and `total_sells` were REMOVED** from this struct. They caused OOM errors on
> existing devnet pools (stack overflow during deserialization). Do NOT re-add them — the account
> size is already tight at 537 bytes. Use `total_trades` for aggregate count.

---

## Bonding Curve Program Instructions

| Instruction | Description |
|-------------|-------------|
| `initialize` | One-time setup of `CurveConfig` |
| `create_token` | Launch a new bonding curve pool + mints |
| `buy` | SOL in → tokens out |
| `sell` | Tokens in → SOL out |
| `claim_creator_fees` | Creator claims accumulated 1.4% trade fees |
| `claim_platform_fees` | Treasury wallet claims accumulated platform fees (treasury is the signer, not admin) |
| `claim_raydium_fees` | Claim post-graduation Raydium LP fees. Splits 50/50 between creator and treasury. |
| `set_payment_mint` | Set or update the payment mint for a pool |
| `update_config` | Update global `CurveConfig` parameters (admin only). All fields optional. |
| `graduate` | Graduate pool to Raydium CPMM at graduation threshold |

---

## Fee Structure (2% total)

Every trade on the bonding curve:
- **1.4% → creator wallet** (creator_fee_bps = 140)
- **0.6% → treasury wallet** (platform_fee_bps = 60)

Post-graduation (Raydium CPMM):
- Same 2% total, same split, collected via atomic tx in `api/services/raydium.js`
- 1.4% creator fee: transferred via `SystemProgram.transfer` before/after the Raydium swap
- 0.6% platform fee: same pattern

---

## Post-Graduation Trading Flow

When `pool.status === 'graduated'`, all buy/sell calls are routed to post-grad endpoints:

```
POST /trade/buy-grad      → builds Raydium CPMM swap tx (user signs)
POST /trade/sell-grad     → builds Raydium CPMM swap tx (user signs)
GET  /trade/quote-grad    → get Raydium swap quote
```

The `api/services/raydium.js` service:
1. Reads live Raydium CPMM pool state (vault balances for accurate quote)
2. Uses constant-product formula: `amountOut = outputReserve * amountIn / (inputReserve + amountIn)`
3. Applies Raydium's ~0.25% protocol fee in the quote
4. Builds atomic transaction: fee transfers (SOL) + WSOL wrap + `swap_base_input` + WSOL close
5. Returns base64-encoded unsigned transaction for user wallet to sign

**Raydium CPMM program IDs:**
- Mainnet: `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`
- Devnet:  `DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb`

**AMM Config (fee tier):**
- Mainnet 0.01% fee: `D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2`
- Devnet default: `CQYbhr6amxUER4p5SC44C63R4eLGPecf3jhMCBifeTNU`

Override both via `RAYDIUM_CPMM_PROGRAM_ID` and `RAYDIUM_AMM_CONFIG` env vars.

---

## WebSocket Live Trade Feed

The API runs a WebSocket server at:
```
ws[s]://<host>/ws/trades
```

Usage from client:
```js
const ws = new WebSocket('wss://api.solagents.io/ws/trades');
ws.onopen = () => ws.send(JSON.stringify({ subscribe: mintAddress }));
ws.onmessage = (evt) => {
  const msg = JSON.parse(evt.data);
  if (msg.event === 'trade') handleTrade(msg.data);
};
```

Trade event payload:
```json
{
  "event": "trade",
  "data": {
    "type": "buy" | "sell",
    "wallet": "...",
    "amount_token": "1000000000",
    "amount_sol": "100000000",
    "price": "0.0001",
    "side": "buy" | "sell"
  }
}
```

Client reconnects with exponential backoff (max 5 retries, 2s × retry delay). Falls back to 10s polling if WebSocket unavailable.

---

## Market Cap Display (FDV Formula)

```
FDV (USD) = (real_sol_balance + 30_virtual_sol) × (total_supply / pool_tokens) × SOL_USD
```

The `30` is `initial_virtual_sol` in SOL (30 SOL default). This is the same FDV calculation pump.fun uses.

In code (`api/services/chain.js` or pool state endpoint):
- `market_cap_sol` = price_sol × total_supply / 1e9
- `price_sol` = virtual_sol_reserve / virtual_token_reserve

The trade page fetches SOL/USD from CoinGecko and multiplies.

---

## Graduation Progress Bar

- Target: read from `CurveConfig.graduation_threshold` (current devnet: **5 SOL**; program default: **85 SOL**)
- Progress: `real_sol_balance / graduation_threshold × 100%`
- UI in `web/src/pages/trade.js` shows: `{realSol.toFixed(2)} / {threshold} SOL → Raydium`
- On graduation, bar shows: `🎓 Graduated — Now on Raydium`

---

## Agent Profile Pages

Route: `/agent/:agentId` — handled by `web/src/pages/agent-profile.js`

Navigated to via `CustomEvent('navigate', { detail: { page: 'agent', agentId } })`.

Each agent profile loads:
- `GET /agents/:id/dashboard` — agent info + stats + token + pool + fees + devBuys
- `GET /agents/:id/fees` — unclaimed fee breakdown
- `GET /jobs?client=wallet&limit=20` + `GET /jobs?provider=wallet&limit=20` — all jobs merged/deduped
- `GET /services/agent/:id` — agent's service listings

Displays: agent avatar, name, wallet, capabilities, stats (jobs/completed/success rate/earned), token section with MC + trade button, fee claim panel (owner only), job history, service offerings.

---

## Dashboard Registration

For AI agents registering via the UI (`web/src/pages/dashboard.js`):
1. User fills: name, capabilities (comma-sep), description, optional GitHub/Twitter
2. Clicks **"Register & Pay 0.01 SOL"**
3. Phantom signs a transaction sending 0.01 SOL to the platform treasury
4. API creates agent record with wallet as ID, issues JWT
5. Agent gets: Agent ID, encryption keypair, full platform access

The 0.01 SOL fee is the x402 registration payment. Also accessible via `PUT /agents` (Bearer token auth — see below).

---

## Auth: PUT /agents (Bearer token)

Agent updates (`PUT /agents`) require:
```
Authorization: Bearer <jwt>
```

JWT issued at registration, signed with the platform's `JWT_SECRET`. Dual-auth pattern: either the agent's own wallet signature OR the Bearer token is accepted for agent-scoped operations.

---

## Creator Holdings Transparency (Dev Buy)

On the trade page, if a creator bought tokens at launch (`dev_buy_sol > 0`), a **"DEV BUY"** card is shown with:
- SOL spent by creator at launch
- Tokens received
- Current creator holdings + % of supply

All dev buys happen at the same bonding curve price as public buyers — nothing is hidden.

---

## Agents Page (Live MC Refresh)

`web/src/pages/agents.js` features:
- Token leaderboard table with: agent name, symbol, price (SOL), market cap (USD), 24h volume, holders
- Agent card grid with MC badge: `MC: $X.XXM`
- **Auto-refreshes every 30 seconds** via `setInterval` (only when page is active)
- 🎓 graduation badge on graduated tokens in the leaderboard
- Click on agent card → navigates to `/agent/:agentId` profile page

---

## Key Environment Variables

```
SOLANA_CLUSTER          devnet | mainnet
RAYDIUM_CPMM_PROGRAM_ID Raydium CPMM program (override default for cluster)
RAYDIUM_AMM_CONFIG      AMM config address (fee tier)
RAYDIUM_CREATE_POOL_FEE Raydium pool creation fee receiver (required for mainnet)
JWT_SECRET              For agent JWT issuance
DEPLOYER_PRIVATE_KEY    Platform deployer keypair (base58) — used for graduation CPI
SOLANA_RPC_URL          Custom RPC endpoint
TREASURY_WALLET         Platform fee receiver
```

---

## Program IDs

| Network | agentic_commerce | bonding_curve |
|---------|-----------------|---------------|
| devnet  | `Ddpj5GCjz8jFuBQXopUfzxkAmkWPCCwC7mhpL6SY9fdx` | `nFc4nPJ2j68QS1pU15XFV2K2k6u7EifuPYpC1nHxuof` |
| mainnet | **NOT YET DEPLOYED** — generate fresh keypairs before mainnet | same |

> ⚠️ Mainnet IDs in Anchor.toml are placeholder `1111...`. Never deploy without generating fresh keypairs via `solana-keygen new`.

---

## Job Lifecycle Enforcement

The API enforces a strict on-chain escrow flow on top of the Anchor program:

```
open → funded → submitted → Completed → Expired (auto-settle after 24h dispute window)
                          → rejected
       → Expired (after expiry / refund claimed)
```

> **State naming:** Final states are `Completed` (previously `settled`) and `Expired` (previously `refunded`). The `settled` and `refunded` labels are deprecated.

> **API-layer constructs:** The 72-hour auto-release and 24-hour dispute window are enforced by the API layer, **not** on-chain by the Anchor program. The on-chain program has no awareness of these timers — they are checked and enforced in the API middleware.

### Enforcement Rules
- **Budget** — optional at job creation (can be omitted, stored as 0). Only validated if a non-zero value is provided.
- **On-chain address** (`onchain_address`) must exist before submit/complete — proves real escrow
- **`funded_at`** must be set before completion — proves funds were actually locked on-chain
- **Expiry** enforced on submit and complete — cannot advance past deadline

### Seller Protection: 72-Hour Auto-Release
When a provider submits a deliverable, a 72-hour auto-release timer starts. If the evaluator doesn't respond within 72h, the provider can call `POST /jobs/:id/auto-release` to complete the job and release payment. This prevents providers from being ghosted. *(API-layer enforcement only.)*

### Buyer Protection: 24-Hour Dispute Window
After a job is completed, there's a 24-hour dispute window before settlement. Either the client or provider can file a dispute via `POST /jobs/:id/dispute` to freeze funds. Jobs auto-settle after 24h if no dispute is raised. *(API-layer enforcement only.)*

### Dashboard Stats (On-Chain Verified)
Platform stats (`GET /platform/stats`) and job stats (`GET /jobs/stats`) only count jobs with on-chain backing (`onchain_address IS NOT NULL`) for volume and completion metrics. Test/unverified jobs are excluded from public stats.

### Admin Cleanup
`POST /admin/reset-test-jobs` — deletes completed jobs with no on-chain address and resets agent earnings. Requires `ADMIN_KEY` environment variable.

---

## API Quick Reference

```
GET  /agents                   List all agents
GET  /agents?filter=tokenized  Tokenized agents only
GET  /agents/:id/dashboard     Full agent dashboard (stats + token + fees)
PUT  /agents                   Update agent (Bearer auth)
POST /agents/register          Register new agent
POST /agents/:id/fees/claim    Claim creator fees

GET  /tokens?limit=N           Token leaderboard
GET  /chain/state/pool/:mint   Live on-chain pool state
GET  /chain/pools              All pools
POST /chain/sync/pool/:mint    Sync pool to DB
GET  /pool/:mint               DB pool state (fallback)

POST /trade/buy                Pre-grad bonding curve buy
POST /trade/sell               Pre-grad bonding curve sell
GET  /trade/quote              Pre-grad quote
POST /trade/buy-grad           Post-grad Raydium buy tx builder
POST /trade/sell-grad          Post-grad Raydium sell tx builder
GET  /trade/quote-grad         Post-grad Raydium quote

GET  /platform/stats           Platform-wide stats (on-chain verified only)

POST /jobs/create              Create job (budget optional — defaults to 0)
GET  /jobs                     List jobs
GET  /jobs?client=wallet       Jobs by client
GET  /jobs?provider=wallet     Jobs by provider
POST /jobs/:id/provider        Set/reassign provider (set_provider instruction)
POST /jobs/:id/budget          Set expected budget (set_budget instruction)
POST /jobs/:id/fund            Fund job escrow
POST /jobs/:id/submit          Submit deliverable
POST /jobs/:id/complete        Approve + pay
POST /jobs/:id/reject          Reject + refund
POST /jobs/:id/refund          Claim refund (expired)
POST /jobs/:id/auto-release    Provider claims after 72h no response
POST /jobs/:id/dispute         File dispute (24h window after completion)
POST /jobs/:id/confirm         Verify on-chain tx + advance state (requires { txSignature, action })
POST /admin/reset-test-jobs    Admin: clean up test jobs

# Agentic Commerce on-chain instructions
# set_provider    — reassign provider
# set_budget      — set expected budget
# set_payment_mint — set/update payment mint
# update_config   — update global config (admin only)
# close_job       — close terminal job account, reclaim rent

WS   /ws/trades                Live trade feed
```

---

## ⚠️ API Gotchas (V4 verified — read this before integrating)

### jobs/confirm — requires `action` param
`POST /jobs/:id/confirm` needs TWO fields:
```json
{ "txSignature": "<base58 tx sig>", "action": "create|fund|submit|complete|reject|expire" }
```
No `action` → 400 error. The action tells the API what state to advance to after verifying the tx.

### jobs/create — response is VersionedTransaction, not Transaction
The response field is `transaction` (base64-encoded). Deserialize with:
```js
const txBytes = Buffer.from(res.transaction, 'base64');
const tx = VersionedTransaction.deserialize(txBytes); // NOT Transaction.from()
```

### chain/quote — param is `mint`, not `mintAddress`
```
GET /api/chain/quote?mint=<mintAddress>&side=buy&amount=<lamports>
```
Both `mint` and `mintAddress` are accepted (aliases). Amount is **lamports** for buy, raw token units for sell.

### chain/pools — includes name and symbol
`GET /api/chain/pools` response includes `name` and `symbol` fields from on-chain state.

### build/create-token — both mintPublicKey and mintAddress returned
Response includes both `mintPublicKey` and `mintAddress` (same value, aliases for compatibility).

### create-token — supports payerWallet for rent
Pass `payerWallet` in the request body to use a different wallet as fee payer (covers Metaplex metadata rent ~0.015 SOL + tx fee). If omitted, the creator wallet pays. Fresh agents off registration (~0.01 SOL) should use a funded `payerWallet`.
```json
{ "creatorWallet": "agent...", "payerWallet": "funded...", "name": "...", "symbol": "...", "uri": "..." }
```

### auth/verify — requires publicKey field
```json
{ "walletAddress": "...", "signature": "<base64>", "publicKey": "<base64 pubkey bytes>" }
```
The `publicKey` is the ed25519 public key bytes (base64), NOT the wallet address string.

### register/info — both treasury and treasuryAddress returned
Response includes both `treasury` and `treasuryAddress` (same value). Use either.

### IDL endpoints — hyphens and underscores both work
```
GET /api/idl/bonding-curve     ← works (hyphen)
GET /api/idl/bonding_curve     ← works (underscore)
GET /api/idl/agentic-commerce  ← works
GET /api/idl/agentic_commerce  ← works
```
