# Agentic Commerce Program — SKILL.md

## Program ID
- Devnet/Localnet: `Ddpj5GCjz8jFuBQXopUfzxkAmkWPCCwC7mhpL6SY9fdx`
- Mainnet: **NOT DEPLOYED** — generate fresh keypair before mainnet

## Overview

Anchor program implementing a **6-state on-chain job escrow** between humans and AI agents, with:
- USDC (configurable SPL token) escrow in per-job vaults
- Evaluator attestation pattern
- Composable hook callbacks on state transitions
- Auto-ATA creation for provider/treasury at payout
- Automatic refund on expiry (no admin needed)

---

## State Machine

```
Open → Funded → Submitted → Completed ✓
                          ↘ Rejected (refund to client)
           ↘ (expired)  → ClaimRefund (client)
```

State enum: `JobStatus { Open, Funded, Submitted, Completed, Rejected, Refunded }`

### Transitions

| From | To | Who | Instruction |
|------|-----|-----|-------------|
| Open | Open | Client | `set_provider` |
| Open | Funded | Client | `fund` |
| Funded | Submitted | Provider | `submit` |
| Submitted | Completed | Evaluator | `complete` |
| Submitted | Rejected | Evaluator | `reject` |
| Funded | Refunded | Client (after expiry) | `claim_refund` |

---

## Instructions

### `initialize`
Creates global `PlatformConfig` (admin, treasury, payment_mint, fee_bps). One per deployment.

### `create_job`
- Creates `Job` account (PDA: `["job", config.key(), job_id_le_bytes]`)
- Creates token vault (PDA: `["vault", job.key()]`)
- Sets: client, evaluator (default = client), description, budget, deadline, hooks

### `set_provider`
Sets the provider wallet on an Open job.

**Guard:** `job.provider == Pubkey::default()` — **returns error if provider already set** (409-equivalent: `ProviderAlreadySet`). This prevents double-assignment bugs. You cannot reassign a provider once set.

```rust
constraint = job.provider == Pubkey::default() @ CommerceError::ProviderAlreadySet,
```

If you need to change provider, the job must be in `Open` state AND have no provider set. Create a new job if you need to re-assign.

### `fund`
- Client transfers `job.budget` USDC from their ATA → job vault
- Transition: Open → Funded

### `submit`
- Provider submits deliverable hash/URI
- Transition: Funded → Submitted
- Records `submitted_at` timestamp

### `complete`
- Evaluator approves; vault disbursed to provider (minus fee) and treasury
- **`init_if_needed`** on both `provider_token` ATA and `treasury_token` ATA — auto-creates them if missing. This avoids requiring the provider to have a pre-existing USDC ATA before receiving payment.
- Transition: Submitted → Completed

```rust
#[account(
    init_if_needed,
    payer = evaluator,
    associated_token::mint = payment_mint,
    associated_token::authority = provider,
)]
pub provider_token: Account<'info, TokenAccount>,
```

### `reject`
- Evaluator rejects; vault refunded to client
- **`init_if_needed`** on `client_token` ATA — auto-creates if missing
- Transition: Submitted → Rejected

### `claim_refund`
- Client claims vault after deadline has passed
- **`init_if_needed`** on `client_token` ATA — auto-creates if missing
- Deliberately **unhookable** (no before/after hook callbacks) — this is the safety escape hatch
- Works from `Funded` state (provider never submitted) or `Submitted` if deadline passed

### `set_budget` (v2)
- Update job budget before funding. Must be in Open state.

### `set_payment_mint`
- **Admin-only** instruction to change the accepted payment SPL mint
- Useful on devnet where USDC mint addresses change between clusters
- Existing funded jobs are **unaffected** — they already hold tokens in their vaults
- Emits `PaymentMintUpdated` event

```rust
pub fn handler(ctx: Context<SetPaymentMint>) -> Result<()> {
    config.payment_mint = ctx.accounts.new_payment_mint.key();
    // ...
}
```

### `update_config`
- Admin: update fee bps, treasury, admin transfer

### `close_job`
- Admin can close dust/abandoned jobs and recover rent

---

## TX Verification Pattern

API-side pattern for handling on-chain transaction confirmation:

1. **Build tx** → record in DB with status `pending_*` (e.g., `pending_fund`, `pending_submit`)
2. **Return tx** to client for wallet signing
3. Client signs + broadcasts
4. Client calls `POST /jobs/:id/confirm` with signature
5. API calls `connection.confirmTransaction(sig, 'confirmed')`
6. On success: advance DB job state to the actual status

Intermediate `pending_*` states prevent double-funding, track in-flight operations, and allow clean retry on RPC failure.

Example states: `pending_fund`, `pending_submit`, `pending_complete`, `pending_refund`

---

## Hook System

Optional CPI callbacks on every transition (except `claim_refund`):
- `before_hook_program` — called before state change
- `after_hook_program` — called after state change

Hook programs receive job state snapshot. Use for:
- Reputation tracking
- Allowlist enforcement
- External notifications
- Multi-sig evaluator requirements

Hook accounts passed as remaining accounts in the instruction.

---

## PDAs

| Account | Seeds |
|---------|-------|
| `PlatformConfig` | `["config"]` |
| `Job` | `["job", config.key(), job_id_le_bytes]` |
| Job vault (token) | `["vault", job.key()]` |

---

## Key Structs

### `PlatformConfig`
```rust
pub struct PlatformConfig {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub payment_mint: Pubkey,   // Configurable via set_payment_mint
    pub fee_bps: u16,           // Platform fee (default: 100 = 1%)
    pub job_count: u64,
    pub bump: u8,
}
```

### `Job`
```rust
pub struct Job {
    pub job_id: u64,
    pub client: Pubkey,
    pub provider: Pubkey,       // Pubkey::default() until set_provider called
    pub evaluator: Pubkey,      // Default = client
    pub budget: u64,            // USDC amount (6 decimals)
    pub deadline: i64,          // Unix timestamp
    pub status: JobStatus,
    pub description: String,    // #[max_len(500)]
    pub deliverable: String,    // #[max_len(500)] — set on submit
    pub reason: [u8; 32],       // Set on complete/reject
    pub created_at: i64,
    pub funded_at: i64,
    pub submitted_at: i64,
    pub completed_at: i64,
    pub vault_bump: u8,
    pub bump: u8,
    // hook_program fields...
}
```

---

## Error Codes

- `UnauthorizedClient` — signer is not job.client
- `UnauthorizedProvider` — signer/address is not job.provider
- `UnauthorizedEvaluator` — signer is not job.evaluator
- `InvalidState` — wrong job status for instruction
- `ProviderAlreadySet` — `set_provider` called when provider != default (409-equivalent)
- `ZeroProvider` — `set_provider` called with default pubkey
- `Overflow` — arithmetic overflow in fee calculation
- `DeadlineNotPassed` — `claim_refund` called before deadline

---

## API-Level Enforcement Layer

The on-chain program defines the base state machine. The API (`api/routes/jobs.js`) adds an additional enforcement layer on top:

### Lifecycle Guards (API-side)
- **Budget > 0** — enforced at job creation; the on-chain program doesn't validate budget amount
- **`onchain_address` required** — submit and complete are blocked until the job has a confirmed on-chain escrow address (set via `/confirm` after funding)
- **`funded_at` required for complete** — prevents completing a job that was never actually funded on-chain
- **Expiry enforcement** — submit and complete check `expired_at` server-side, rejecting late actions before they hit the chain

### Seller Protection: 72-Hour Auto-Release
- When a deliverable is submitted and confirmed on-chain, `auto_release_at` is set to `now + 72h`
- If the evaluator doesn't act within 72h, `POST /jobs/:id/auto-release` builds a `complete` instruction the provider can sign
- This is an API-level protection — the on-chain program sees a normal `complete` instruction

### Buyer Protection: 24-Hour Dispute Window
- After completion, `completed_at` is recorded and a 24h dispute window opens
- `POST /jobs/:id/dispute` creates a dispute record (stored in a `disputes` table) and sets `dispute_status = 'open'` on the job
- Disputes freeze the job — `settled_at` is not set while a dispute is open
- Jobs without disputes auto-settle after 24h (checked on read via `checkAutoExpiry`)

### Settlement
- `settled_at` is set automatically when a completed job passes the 24h dispute window with no disputes
- Settlement is checked lazily on every `GET /jobs/:id` and `GET /jobs` read
- Once settled, disputes can no longer be filed

### Admin Cleanup
- `POST /admin/reset-test-jobs` deletes completed jobs with `onchain_address IS NULL` and resets `agent_stats` earnings
- Keeps the dashboard stats honest by removing test/unverified data

### DB Schema Additions (v3)
New columns on `jobs` table:
- `funded_at INTEGER` — timestamp when funding was confirmed on-chain
- `submitted_at INTEGER` — timestamp when submission was confirmed
- `auto_release_at INTEGER` — 72h deadline after submission
- `settled_at INTEGER` — when the dispute window closed
- `dispute_status TEXT` — `'open'` or `NULL`

New table: `disputes` — `id`, `job_id`, `raised_by`, `reason`, `status` (open/resolved), `resolution`, timestamps

---

## Known Issues / Lessons Learned

1. **`set_provider` 409 guard** — the `job.provider == Pubkey::default()` constraint prevents accidental double-assignment. This is intentional. Do not remove it; create a new job if reassignment is needed.

2. **`init_if_needed` on payout** — `complete`, `reject`, and `claim_refund` all use `init_if_needed` on recipient ATAs. This means the evaluator/client must pay rent for the ATA if it doesn't exist. Always ensure evaluator has enough SOL to cover ATA rent (~0.002 SOL per ATA).

3. **`set_payment_mint` for devnet** — USDC mint differs between devnet clusters. Use `set_payment_mint` to update without redeploying. This is an admin-only operation and does not affect existing funded jobs.

4. **`claim_refund` is unhookable** — by design. Even if a before_hook program misbehaves (panics, blocks), clients can always recover their funds after expiry. Never add hooks to `claim_refund`.

5. **TX verification pending states** — always record `pending_*` states server-side before returning unsigned tx to client. If client abandons, the pending state allows cleanup. Check `connection.confirmTransaction` result before advancing job state.
