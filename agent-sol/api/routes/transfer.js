import { v4 as uuidv4 } from 'uuid';
import { stmts } from '../services/db.js';
import { authHook } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';

/**
 * Transfer & Escrow Routes
 * 
 * Agent-to-SolAgents and SPL token transfers.
 * Escrow for conditional/trustless transfers.
 */
export default async function transferRoutes(fastify) {

  // Record a direct transfer between agents
  fastify.post('/api/transfer', {
    preHandler: [authHook, rateLimit({ max: 20, windowMs: 60_000 })],
  }, async (request, reply) => {
    const { recipientId, token, amount, txSignature } = request.body || {};

    if (!recipientId || !token || !amount || !txSignature) {
      return reply.code(400).send({
        error: 'Required: recipientId, token, amount, txSignature',
      });
    }

    const recipient = stmts.getAgent.get(recipientId);
    if (!recipient || recipient.status !== 'active') {
      return reply.code(404).send({ error: 'Recipient agent not found' });
    }

    if (recipientId === request.agent.id) {
      return reply.code(400).send({ error: 'Cannot transfer to yourself' });
    }

    const transferId = `xfer_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

    stmts.insertTransfer.run(
      transferId,
      request.agent.id,
      recipientId,
      token,
      String(amount)
    );
    stmts.updateTransfer.run('confirmed', txSignature, transferId);

    return reply.code(201).send({
      success: true,
      transferId,
      from: request.agent.id,
      to: recipientId,
      token,
      amount,
      txSignature,
    });
  });

  // Create an escrow
  fastify.post('/api/escrow/create', {
    preHandler: [authHook, rateLimit({ max: 5, windowMs: 300_000 })],
  }, async (request, reply) => {
    const { counterpartyId, token, amount, condition, expiresInHours } = request.body || {};

    if (!counterpartyId || !token || !amount) {
      return reply.code(400).send({
        error: 'Required: counterpartyId, token, amount',
      });
    }

    const counterparty = stmts.getAgent.get(counterpartyId);
    if (!counterparty || counterparty.status !== 'active') {
      return reply.code(404).send({ error: 'Counterparty agent not found' });
    }

    const escrowId = `escrow_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
    const expiresAt = expiresInHours
      ? Math.floor(Date.now() / 1000) + (expiresInHours * 3600)
      : Math.floor(Date.now() / 1000) + (72 * 3600); // default 72h

    stmts.insertEscrow.run(
      escrowId,
      request.agent.id,
      counterpartyId,
      token,
      String(amount),
      condition || null,
      expiresAt
    );

    return reply.code(201).send({
      success: true,
      escrowId,
      creator: request.agent.id,
      counterparty: counterpartyId,
      token,
      amount,
      condition,
      expiresAt,
      hint: 'Fund this escrow by sending tokens to the escrow program address, then call /api/escrow/:id/fund',
    });
  });

  // Release escrow
  fastify.post('/api/escrow/:id/release', {
    preHandler: [authHook],
  }, async (request, reply) => {
    const escrow = stmts.getEscrow.get(request.params.id);
    if (!escrow) return reply.code(404).send({ error: 'Escrow not found' });

    if (escrow.creator_id !== request.agent.id) {
      return reply.code(403).send({ error: 'Only escrow creator can release' });
    }

    if (escrow.status !== 'active') {
      return reply.code(400).send({ error: `Escrow is ${escrow.status}, cannot release` });
    }

    stmts.updateEscrow.run('released', request.params.id);

    return { success: true, escrowId: request.params.id, status: 'released' };
  });

  // Refund escrow (creator only, before expiry or if conditions not met)
  fastify.post('/api/escrow/:id/refund', {
    preHandler: [authHook],
  }, async (request, reply) => {
    const escrow = stmts.getEscrow.get(request.params.id);
    if (!escrow) return reply.code(404).send({ error: 'Escrow not found' });

    if (escrow.creator_id !== request.agent.id) {
      return reply.code(403).send({ error: 'Only escrow creator can refund' });
    }

    if (escrow.status !== 'active') {
      return reply.code(400).send({ error: `Escrow is ${escrow.status}, cannot refund` });
    }

    stmts.updateEscrow.run('refunded', request.params.id);

    return { success: true, escrowId: request.params.id, status: 'refunded' };
  });

  // Get escrow details
  fastify.get('/api/escrow/:id', {
    preHandler: [authHook],
  }, async (request, reply) => {
    const escrow = stmts.getEscrow.get(request.params.id);
    if (!escrow) return reply.code(404).send({ error: 'Escrow not found' });

    // Only participants can view
    if (escrow.creator_id !== request.agent.id && escrow.counterparty_id !== request.agent.id) {
      return reply.code(403).send({ error: 'Not a participant in this escrow' });
    }

    return {
      escrowId: escrow.id,
      creator: escrow.creator_id,
      counterparty: escrow.counterparty_id,
      token: escrow.token,
      amount: escrow.amount,
      condition: escrow.condition,
      status: escrow.status,
      expiresAt: escrow.expires_at,
      createdAt: escrow.created_at,
    };
  });
}
