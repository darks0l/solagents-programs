import { stmts } from '../services/db.js';
import { verifyWalletSignature, generateChallenge } from '../services/crypto.js';

// In-memory challenge store (short-lived nonces for wallet auth)
const challenges = new Map();
const CHALLENGE_TTL = 300_000; // 5 minutes

// Cleanup expired challenges every 60s
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of challenges) {
    if (now - val.created > CHALLENGE_TTL) challenges.delete(key);
  }
}, 60_000);

/**
 * Request a challenge nonce for wallet authentication.
 * Agent calls this first, signs the nonce, then sends signature to authenticate.
 */
export function requestChallenge(walletAddress) {
  const nonce = generateChallenge();
  const message = `AgentSol Auth: ${nonce}`;
  challenges.set(walletAddress, { nonce, message, created: Date.now() });
  return { message, nonce };
}

/**
 * Verify a wallet signature against a previously issued challenge.
 */
export function verifyChallenge(walletAddress, signatureB64, publicKeyB64) {
  const challenge = challenges.get(walletAddress);
  if (!challenge) return { valid: false, error: 'No challenge found — request one first' };

  const now = Date.now();
  if (now - challenge.created > CHALLENGE_TTL) {
    challenges.delete(walletAddress);
    return { valid: false, error: 'Challenge expired' };
  }

  const valid = verifyWalletSignature(challenge.message, signatureB64, publicKeyB64);
  if (valid) challenges.delete(walletAddress); // one-time use

  return { valid, error: valid ? undefined : 'Signature verification failed' };
}

/**
 * Fastify auth hook — verifies bearer token (agent ID + wallet signature).
 * 
 * Expected header: Authorization: Bearer <agentId>:<signatureB64>
 * The signature must be over a recent timestamp: "AgentSol:<agentId>:<timestamp>"
 * Timestamp must be within 5 minutes.
 */
export async function authHook(request, reply) {
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Missing authorization header' });
  }

  const token = auth.slice(7);
  const [agentId, signatureB64, timestampStr] = token.split(':');

  if (!agentId || !signatureB64 || !timestampStr) {
    return reply.code(401).send({ error: 'Invalid auth format. Expected: Bearer <agentId>:<signature>:<timestamp>' });
  }

  const timestamp = parseInt(timestampStr);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 300) {
    return reply.code(401).send({ error: 'Auth token expired (>5 min drift)' });
  }

  const agent = stmts.getAgent.get(agentId);
  if (!agent) {
    return reply.code(401).send({ error: 'Agent not found' });
  }

  if (agent.status !== 'active') {
    return reply.code(403).send({ error: `Agent status: ${agent.status}` });
  }

  // Verify signature over the auth message
  const message = `AgentSol:${agentId}:${timestampStr}`;
  // Agent's wallet pubkey is stored as base58 — we need to handle both formats
  // For ed25519 verification we use the raw wallet pubkey bytes
  try {
    const { PublicKey } = await import('@solana/web3.js');
    const pubkeyBytes = new PublicKey(agent.wallet_address).toBytes();
    const pubkeyB64 = Buffer.from(pubkeyBytes).toString('base64');
    
    const valid = verifyWalletSignature(message, signatureB64, pubkeyB64);
    if (!valid) {
      return reply.code(401).send({ error: 'Signature verification failed' });
    }
  } catch (err) {
    return reply.code(401).send({ error: `Auth error: ${err.message}` });
  }

  // Attach agent to request
  request.agent = agent;
  stmts.updateLastSeen.run(agentId);
}

/**
 * Optional auth — sets request.agent if valid, but doesn't reject.
 */
export async function optionalAuth(request) {
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return;

  try {
    const token = auth.slice(7);
    const [agentId] = token.split(':');
    const agent = stmts.getAgent.get(agentId);
    if (agent?.status === 'active') {
      request.agent = agent;
      stmts.updateLastSeen.run(agentId);
    }
  } catch {
    // Silent fail for optional auth
  }
}
