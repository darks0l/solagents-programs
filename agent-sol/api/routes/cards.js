import { v4 as uuidv4 } from 'uuid';
import { stmts } from '../services/db.js';
import { authHook } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';

/**
 * Prepaid Card Routes
 * 
 * Bridges to the DARKSOL card provider (Trocador-based).
 * Agents pay with SOL/SPL tokens, receive prepaid Visa/Mastercard.
 */

const CARD_API = process.env.CARD_API_URL || 'https://acp.darksol.net';
const CARD_API_KEY = process.env.CARD_API_KEY || '';

export default async function cardRoutes(fastify) {

  // Get available card options
  fastify.get('/api/cards/options', {
    preHandler: [authHook],
  }, async () => {
    return {
      cards: [
        { type: 'visa', denominations: [25, 50, 100, 200, 500], currency: 'USD' },
        { type: 'mastercard', denominations: [25, 50, 100, 200, 500], currency: 'USD' },
        { type: 'visa', denominations: [25, 50, 100, 200, 500], currency: 'EUR' },
      ],
      acceptedPayments: ['SOL', 'USDC', 'USDT'],
      note: 'Prices include exchange fees. Payment verified on-chain before card delivery.',
    };
  });

  // Order a prepaid card
  fastify.post('/api/cards/order', {
    preHandler: [authHook, rateLimit({ max: 5, windowMs: 300_000 })],
  }, async (request, reply) => {
    const { cardType, denomination, currency, paymentToken, paymentTx, deliveryEmail } = request.body || {};

    if (!cardType || !denomination || !currency || !paymentTx) {
      return reply.code(400).send({
        error: 'Required: cardType, denomination, currency, paymentTx',
        hint: 'Check GET /api/cards/options for available options',
      });
    }

    const validTypes = ['visa', 'mastercard'];
    if (!validTypes.includes(cardType)) {
      return reply.code(400).send({ error: `cardType must be one of: ${validTypes.join(', ')}` });
    }

    const orderId = `card_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

    // Record the order
    stmts.insertCardOrder.run(
      orderId,
      request.agent.id,
      cardType,
      String(denomination),
      currency
    );

    // Forward to card provider (async)
    let providerRef = null;
    try {
      if (CARD_API_KEY) {
        const res = await fetch(`${CARD_API}/cards/order`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${CARD_API_KEY}`,
          },
          body: JSON.stringify({
            cardType,
            denomination,
            currency,
            paymentTx,
            paymentToken: paymentToken || 'SOL',
            deliveryEmail,
            agentId: request.agent.id,
          }),
        });

        const data = await res.json();
        providerRef = data.orderId || data.ref || null;

        stmts.updateCardOrder.run(
          res.ok ? 'processing' : 'failed',
          providerRef,
          paymentTx,
          orderId
        );
      } else {
        // No card API configured — mark as pending
        stmts.updateCardOrder.run('pending', null, paymentTx, orderId);
      }
    } catch (err) {
      stmts.updateCardOrder.run('pending', null, paymentTx, orderId);
    }

    return reply.code(201).send({
      success: true,
      orderId,
      status: providerRef ? 'processing' : 'pending',
      providerRef,
      message: 'Card order submitted. Check status with GET /api/cards/:orderId',
    });
  });

  // Check card order status
  fastify.get('/api/cards/:orderId', {
    preHandler: [authHook],
  }, async (request, reply) => {
    const orders = stmts.getAgentCards.all(request.agent.id, 100);
    const order = orders.find(o => o.id === request.params.orderId);

    if (!order) {
      return reply.code(404).send({ error: 'Order not found' });
    }

    return {
      orderId: order.id,
      cardType: order.card_type,
      amount: order.amount,
      currency: order.currency,
      status: order.status,
      providerRef: order.provider_ref,
      createdAt: order.created_at,
      completedAt: order.completed_at,
    };
  });

  // List agent's card orders
  fastify.get('/api/cards', {
    preHandler: [authHook],
  }, async (request) => {
    const limit = Math.min(parseInt(request.query.limit) || 20, 50);
    const orders = stmts.getAgentCards.all(request.agent.id, limit);

    return {
      orders: orders.map(o => ({
        orderId: o.id,
        cardType: o.card_type,
        amount: o.amount,
        currency: o.currency,
        status: o.status,
        createdAt: o.created_at,
      })),
    };
  });
}
