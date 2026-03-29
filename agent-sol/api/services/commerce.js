import { Connection, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from '@solana/spl-token';

/**
 * Agentic Commerce Protocol — Client SDK.
 * Builds and sends transactions for the on-chain program.
 * 
 * This mirrors EIP-8183 state machine:
 * Open → Funded → Submitted → Completed/Rejected/Expired
 */

const PROGRAM_ID = new PublicKey(process.env.COMMERCE_PROGRAM_ID || 'Ddpj5GCjz8jFuBQXopUfzxkAmkWPCCwC7mhpL6SY9fdx');
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';

const connection = new Connection(SOLANA_RPC, 'confirmed');

// PDA derivation helpers

export function getConfigPDA() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('config')],
    PROGRAM_ID,
  );
}

export function getJobPDA(configKey, jobId) {
  const jobIdBuf = Buffer.alloc(8);
  jobIdBuf.writeBigUInt64LE(BigInt(jobId));
  return PublicKey.findProgramAddressSync(
    [Buffer.from('job'), configKey.toBuffer(), jobIdBuf],
    PROGRAM_ID,
  );
}

export function getVaultPDA(jobKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), jobKey.toBuffer()],
    PROGRAM_ID,
  );
}

// Job status enum matching on-chain
export const JobStatus = {
  0: 'Open',
  1: 'Funded',
  2: 'Submitted',
  3: 'Completed',
  4: 'Rejected',
  5: 'Expired',
};

/**
 * Fetch a job account from chain.
 */
export async function fetchJob(jobKey) {
  const accountInfo = await connection.getAccountInfo(new PublicKey(jobKey));
  if (!accountInfo) return null;

  // Decode using Anchor discriminator + layout
  // In production, use @coral-xyz/anchor to deserialize
  return {
    raw: accountInfo.data,
    lamports: accountInfo.lamports,
    owner: accountInfo.owner.toBase58(),
  };
}

/**
 * Fetch platform config.
 */
export async function fetchConfig() {
  const [configKey] = getConfigPDA();
  const accountInfo = await connection.getAccountInfo(configKey);
  if (!accountInfo) return null;
  return {
    address: configKey.toBase58(),
    raw: accountInfo.data,
    lamports: accountInfo.lamports,
  };
}

/**
 * Build a createJob instruction.
 * Returns structured instruction data (not a serialized transaction).
 *
 * FORMAT NOTE: This returns `format: 'instruction'` — raw instruction parameters
 * that agents must use with the Agentic Commerce IDL to construct and sign
 * the actual transaction client-side. Fetch the IDL at GET /api/idl/agentic_commerce.
 *
 * On-chain derivation of the job PDA requires reading the current job counter
 * from the config account. Agents should:
 *   1. Fetch config PDA to get current jobCounter
 *   2. Derive jobPDA using [b"job", configKey, jobCounter as little-endian u64]
 *   3. Build create_job instruction using the IDL + Anchor
 *   4. Sign and submit the transaction
 *   5. Call POST /api/jobs/:id/confirm with txSignature + onchainAddress
 */
export function buildCreateJobTx({
  client,
  provider,
  evaluator,
  expiredAt,
  description,
  hook,
  paymentMint,
}) {
  const [configKey] = getConfigPDA();

  return {
    format: 'instruction',
    programId: PROGRAM_ID.toBase58(),
    configKey: configKey.toBase58(),
    instruction: 'create_job',
    params: {
      provider: provider || PublicKey.default.toBase58(),
      evaluator,
      expiredAt,
      description,
      hook: hook || PublicKey.default.toBase58(),
    },
    requiredSigners: [client],
    pdaDerivation: {
      note: 'Derive jobPDA after reading jobCounter from config account',
      seeds: ['job', '<configKey>', '<jobCounter as little-endian u64>'],
      programId: PROGRAM_ID.toBase58(),
    },
    idl: 'GET /api/idl/agentic_commerce',
    note: 'Use this instruction data + IDL to build the transaction client-side. Sign and submit, then call POST /api/jobs/:jobId/confirm',
  };
}

/**
 * Build instruction data for any commerce action.
 * Returns structured data for client-side signing.
 */
export function buildInstruction(action, params) {
  const [configKey] = getConfigPDA();

  const instructions = {
    set_provider: {
      accounts: ['client (signer)', 'job (mut)', 'hook_program'],
      params: { provider: params.provider, opt_params: params.optParams || [] },
    },
    set_budget: {
      accounts: ['caller (signer)', 'job (mut)', 'hook_program'],
      params: { amount: params.amount, opt_params: params.optParams || [] },
    },
    fund: {
      accounts: ['client (signer)', 'job (mut)', 'client_token (mut)', 'vault (mut)', 'token_program', 'hook_program'],
      params: { expected_budget: params.expectedBudget, opt_params: params.optParams || [] },
    },
    submit: {
      accounts: ['provider (signer)', 'job (mut)', 'hook_program'],
      params: { deliverable: params.deliverable, opt_params: params.optParams || [] },
    },
    complete: {
      accounts: ['evaluator (signer)', 'job (mut)', 'config', 'vault (mut)', 'provider_token (mut)', 'treasury_token (mut)', 'token_program', 'hook_program'],
      params: { reason: params.reason || new Array(32).fill(0), opt_params: params.optParams || [] },
    },
    reject: {
      accounts: ['caller (signer)', 'job (mut)', 'config', 'vault (mut)', 'client_token (mut)', 'token_program', 'hook_program'],
      params: { reason: params.reason || new Array(32).fill(0), opt_params: params.optParams || [] },
    },
    claim_refund: {
      accounts: ['caller (signer)', 'job (mut)', 'config', 'vault (mut)', 'client_token (mut)', 'token_program'],
      params: {},
    },
  };

  const ix = instructions[action];
  if (!ix) throw new Error(`Unknown action: ${action}`);

  return {
    programId: PROGRAM_ID.toBase58(),
    configKey: configKey.toBase58(),
    instruction: action,
    ...ix,
  };
}

/**
 * Get all job PDAs for a range of job IDs.
 */
export function getJobPDAs(configKey, fromId, count) {
  const pdas = [];
  for (let i = fromId; i < fromId + count; i++) {
    const [jobKey, bump] = getJobPDA(new PublicKey(configKey), i);
    pdas.push({ jobId: i, address: jobKey.toBase58(), bump });
  }
  return pdas;
}

export { connection, PROGRAM_ID };
