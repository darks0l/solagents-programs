import { v4 as uuidv4 } from 'uuid';
import { stmts } from '../services/db.js';
import { verifyRegistrationPayment, getRegistrationInfo } from '../services/x402.js';
import { requestChallenge, verifyChallenge } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';

/**
 * Agent Registration Routes
 * 
 * Flow:
 * 1. GET /api/register/info — Get treasury address + fee
 * 2. Agent sends SOL to treasury
 * 3. POST /api/register — Submit registration with tx signature
 */
export default async function registerRoutes(fastify) {

  // Get registration requirements
  fastify.get('/api/register/info', async () => {
    return getRegistrationInfo();
  });

  // Request auth challenge (for existing agents)
  fastify.post('/api/auth/challenge', {
    preHandler: [rateLimit({ max: 10, windowMs: 60_000 })],
  }, async (request) => {
    const { walletAddress } = request.body || {};
    if (!walletAddress) {
      return { error: 'walletAddress required' };
    }
    return requestChallenge(walletAddress);
  });

  // Verify auth challenge
  fastify.post('/api/auth/verify', {
    preHandler: [rateLimit({ max: 10, windowMs: 60_000 })],
  }, async (request, reply) => {
    const { walletAddress, signature, publicKey } = request.body || {};
    if (!walletAddress || !signature || !publicKey) {
      return reply.code(400).send({ error: 'walletAddress, signature, and publicKey required' });
    }

    const result = verifyChallenge(walletAddress, signature, publicKey);
    if (!result.valid) {
      return reply.code(401).send({ error: result.error });
    }

    const agent = stmts.getAgentByWallet.get(walletAddress);
    if (!agent) {
      return reply.code(404).send({ error: 'No agent registered with this wallet' });
    }

    // Return agent info + a session hint (agents generate their own bearer tokens)
    return {
      authenticated: true,
      agent: {
        id: agent.id,
        name: agent.name,
        walletAddress: agent.wallet_address,
        status: agent.status,
      },
    };
  });

  // Register a new agent
  fastify.post('/api/register', {
    preHandler: [rateLimit({ max: 5, windowMs: 300_000 })],
  }, async (request, reply) => {
    const { walletAddress, publicKey, name, capabilities, metadata, txSignature } = request.body || {};

    // Validate required fields
    if (!walletAddress || !publicKey || !txSignature) {
      return reply.code(400).send({
        error: 'Required: walletAddress, publicKey, txSignature',
        hint: 'First send registration fee to treasury (GET /api/register/info), then submit tx signature',
      });
    }

    // Check if wallet already registered
    const existing = stmts.getAgentByWallet.get(walletAddress);
    if (existing) {
      return reply.code(409).send({
        error: 'Wallet already registered',
        agentId: existing.id,
      });
    }

    // Verify x402 payment
    const payment = await verifyRegistrationPayment(txSignature, walletAddress);
    if (!payment.valid) {
      return reply.code(402).send({
        error: 'Payment verification failed',
        detail: payment.error,
        ...getRegistrationInfo(),
      });
    }

    // Create agent
    const agentId = `agent_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    
    try {
      stmts.insertAgent.run(
        agentId,
        walletAddress,
        publicKey,
        name || `Agent ${agentId.slice(-6)}`,
        JSON.stringify(capabilities || []),
        JSON.stringify(metadata || {}),
        txSignature
      );
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        return reply.code(409).send({ error: 'Wallet already registered' });
      }
      throw err;
    }

    return reply.code(201).send({
      success: true,
      agent: {
        id: agentId,
        walletAddress,
        publicKey,
        name: name || `Agent ${agentId.slice(-6)}`,
      },
      message: 'Agent registered successfully. Use your wallet to sign auth tokens for API access.',
    });
  });
}
