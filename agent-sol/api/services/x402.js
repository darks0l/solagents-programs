import { Connection, PublicKey } from '@solana/web3.js';

/**
 * x402 payment verification for Solana.
 * Agents pay a registration fee in SOL to prove wallet ownership + fund the platform.
 * 
 * Verification: check that a SOL transfer was made from the agent's wallet
 * to our treasury wallet for the required amount.
 */

const SOLANA_RPC = process.env.SOLANA_RPC_URL || process.env.SOLANA_RPC || 'https://api.devnet.solana.com';
const TREASURY_WALLET = process.env.TREASURY_WALLET || '';
const REGISTRATION_FEE_LAMPORTS = parseInt(process.env.REGISTRATION_FEE_LAMPORTS || '10000000'); // 0.01 SOL default

const connection = new Connection(SOLANA_RPC, 'confirmed');

/**
 * Verify an x402 registration payment.
 * @param {string} txSignature - The Solana transaction signature
 * @param {string} senderWallet - Expected sender wallet address
 * @param {number} [minAmount] - Minimum lamports required
 * @returns {{ valid: boolean, amount?: number, error?: string }}
 */
export async function verifyRegistrationPayment(txSignature, senderWallet, minAmount) {
  const requiredLamports = minAmount || REGISTRATION_FEE_LAMPORTS;

  try {
    const tx = await connection.getParsedTransaction(txSignature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });

    if (!tx) return { valid: false, error: 'Transaction not found' };
    if (tx.meta?.err) return { valid: false, error: 'Transaction failed on-chain' };

    // Find a SOL transfer to our treasury
    const instructions = tx.transaction.message.instructions;
    let paymentFound = false;
    let transferAmount = 0;

    for (const ix of instructions) {
      if (ix.parsed?.type === 'transfer' && ix.program === 'system') {
        const info = ix.parsed.info;
        if (
          info.source === senderWallet &&
          info.destination === TREASURY_WALLET &&
          info.lamports >= requiredLamports
        ) {
          paymentFound = true;
          transferAmount = info.lamports;
          break;
        }
      }
    }

    if (!paymentFound) {
      return { valid: false, error: `No qualifying transfer found to treasury (need ${requiredLamports} lamports)` };
    }

    return { valid: true, amount: transferAmount };

  } catch (err) {
    return { valid: false, error: `Verification error: ${err.message}` };
  }
}

/**
 * Get registration payment details for agents.
 */
export function getRegistrationInfo() {
  return {
    treasury: TREASURY_WALLET,
    treasuryAddress: TREASURY_WALLET, // alias for skills compatibility
    feeLamports: REGISTRATION_FEE_LAMPORTS,
    feeSol: REGISTRATION_FEE_LAMPORTS / 1e9,
    // Aliases matching documented field names
    vaultAddress: TREASURY_WALLET,
    fee: REGISTRATION_FEE_LAMPORTS,
    rpc: SOLANA_RPC.replace(/\/\/.*@/, '//***@'), // mask any auth in URL
  };
}

export { connection, TREASURY_WALLET };
