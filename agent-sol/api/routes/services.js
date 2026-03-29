import { randomUUID } from 'crypto';
import { stmts } from '../services/db.js';

const LAMPORTS_PER_SOL = 1_000_000_000;
const lamportsToSol = (l) => (Number(l) / LAMPORTS_PER_SOL).toFixed(4);

const CATEGORIES = ['audit', 'development', 'review', 'deployment', 'consulting', 'integration', 'testing', 'documentation', 'other'];

export default async function servicesRoutes(fastify) {

  // ═══════════════════════════════════════
  // LIST SERVICES (marketplace browse)
  // ═══════════════════════════════════════
  fastify.get('/api/services', async (request) => {
    const { category, limit = 50, offset = 0 } = request.query;
    let services;
    if (category && CATEGORIES.includes(category)) {
      services = stmts.listServicesByCategory.all(category, Number(limit), Number(offset));
    } else {
      services = stmts.listServices.all(Number(limit), Number(offset));
    }

    return {
      services: services.map(s => ({
        ...s,
        price_sol: lamportsToSol(s.price_lamports),
        agent_capabilities: s.agent_capabilities ? JSON.parse(s.agent_capabilities) : [],
        available: s.active_orders < s.max_concurrent,
      })),
      categories: CATEGORIES,
      pagination: { limit: Number(limit), offset: Number(offset) },
    };
  });

  // ═══════════════════════════════════════
  // GET SERVICE DETAIL
  // ═══════════════════════════════════════
  fastify.get('/api/services/:id', async (request, reply) => {
    const service = stmts.getService.get(request.params.id);
    if (!service) return reply.code(404).send({ error: 'Service not found' });

    return {
      ...service,
      price_sol: lamportsToSol(service.price_lamports),
      available: service.active_orders < service.max_concurrent,
    };
  });

  // ═══════════════════════════════════════
  // CREATE SERVICE (agent lists offering)
  // ═══════════════════════════════════════
  fastify.post('/api/services', async (request, reply) => {
    const { agentId, title, description, category, priceSol, deliveryHours, maxConcurrent, requirements, deliverables } = request.body || {};

    if (!agentId || !title || !description || !category || !priceSol) {
      return reply.code(400).send({ error: 'Missing required fields: agentId, title, description, category, priceSol' });
    }

    if (!CATEGORIES.includes(category)) {
      return reply.code(400).send({ error: `Invalid category. Must be one of: ${CATEGORIES.join(', ')}` });
    }

    const agent = stmts.getAgent.get(agentId);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    const priceLamports = Math.round(Number(priceSol) * LAMPORTS_PER_SOL);
    if (priceLamports <= 0) return reply.code(400).send({ error: 'Price must be greater than 0' });

    const id = `svc_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

    stmts.insertService.run(
      id, agentId, agent.wallet_address, title, description, category,
      priceLamports, deliveryHours || 72, maxConcurrent || 3,
      requirements || '', deliverables || ''
    );

    return {
      id,
      title,
      category,
      price_sol: lamportsToSol(priceLamports),
      message: 'Service listed successfully',
    };
  });

  // ═══════════════════════════════════════
  // UPDATE SERVICE
  // ═══════════════════════════════════════
  fastify.put('/api/services/:id', async (request, reply) => {
    const service = stmts.getService.get(request.params.id);
    if (!service) return reply.code(404).send({ error: 'Service not found' });

    const { title, description, category, priceSol, deliveryHours, maxConcurrent, requirements, deliverables, status } = request.body || {};

    if (category && !CATEGORIES.includes(category)) {
      return reply.code(400).send({ error: `Invalid category` });
    }

    const priceLamports = priceSol ? Math.round(Number(priceSol) * LAMPORTS_PER_SOL) : service.price_lamports;

    stmts.updateService.run(
      title || service.title,
      description || service.description,
      category || service.category,
      priceLamports,
      deliveryHours || service.delivery_hours,
      maxConcurrent ?? service.max_concurrent,
      requirements ?? service.requirements,
      deliverables ?? service.deliverables,
      status || service.status,
      request.params.id
    );

    return { success: true, message: 'Service updated' };
  });

  // ═══════════════════════════════════════
  // PURCHASE SERVICE (buyer buys → auto-creates escrow job)
  // ═══════════════════════════════════════
  fastify.post('/api/services/:id/purchase', async (request, reply) => {
    const service = stmts.getService.get(request.params.id);
    if (!service) return reply.code(404).send({ error: 'Service not found' });
    if (service.status !== 'active') return reply.code(400).send({ error: 'Service is not active' });
    if (service.active_orders >= service.max_concurrent) {
      return reply.code(400).send({ error: 'Service is at max capacity. Try again later.' });
    }

    const { buyerWallet, notes, txSignature } = request.body || {};
    if (!buyerWallet) return reply.code(400).send({ error: 'buyerWallet required' });

    // Create an escrow job with pre-wired roles
    const jobId = randomUUID();
    const expiredAt = Math.floor(Date.now() / 1000) + (service.delivery_hours * 3600);

    stmts.insertJob.run(
      jobId,
      buyerWallet,           // client = buyer
      service.agent_wallet,  // provider = service agent
      buyerWallet,           // evaluator = buyer (they approve deliverable)
      `Service Purchase: ${service.title}`,
      service.price_lamports,
      expiredAt,
      null, // hook
      null  // onchain_address
    );

    // Create service order linking to job
    const orderId = `ord_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    stmts.insertServiceOrder.run(
      orderId, service.id, jobId, buyerWallet,
      service.agent_wallet, service.price_lamports, notes || null
    );

    // Increment active orders
    stmts.incrementServiceOrders.run(service.id);

    return {
      orderId,
      jobId,
      service: {
        id: service.id,
        title: service.title,
        price_sol: lamportsToSol(service.price_lamports),
      },
      escrow: {
        programId: 'Ddpj5GCjz8jFuBQXopUfzxkAmkWPCCwC7mhpL6SY9fdx',
        instruction: 'fund',
        amount: service.price_lamports,
        note: 'Sign the fund transaction to escrow payment. Agent will begin work once funded.',
      },
      message: 'Service purchased. Fund the escrow to begin.',
    };
  });

  // ═══════════════════════════════════════
  // MY SERVICES (agent's own listings)
  // ═══════════════════════════════════════
  fastify.get('/api/services/agent/:agentId', async (request) => {
    const { limit = 50, offset = 0 } = request.query;
    const services = stmts.listServicesByAgent.all(request.params.agentId, Number(limit), Number(offset));
    return {
      services: services.map(s => ({
        ...s,
        price_sol: lamportsToSol(s.price_lamports),
        available: s.active_orders < s.max_concurrent,
      })),
    };
  });

  // ═══════════════════════════════════════
  // SERVICE ORDERS (buyer's purchases)
  // ═══════════════════════════════════════
  fastify.get('/api/services/orders/buyer/:wallet', async (request) => {
    const { limit = 50, offset = 0 } = request.query;
    const orders = stmts.listOrdersByBuyer.all(request.params.wallet, Number(limit), Number(offset));
    return { orders: orders.map(o => ({ ...o, price_sol: lamportsToSol(o.price_lamports) })) };
  });

  // ═══════════════════════════════════════
  // SERVICE ORDERS (provider's incoming orders)
  // ═══════════════════════════════════════
  fastify.get('/api/services/orders/provider/:wallet', async (request) => {
    const { limit = 50, offset = 0 } = request.query;
    const orders = stmts.listOrdersByProvider.all(request.params.wallet, Number(limit), Number(offset));
    return { orders: orders.map(o => ({ ...o, price_sol: lamportsToSol(o.price_lamports) })) };
  });

  // ═══════════════════════════════════════
  // SUBMIT DELIVERABLE (provider completes work)
  // ═══════════════════════════════════════
  fastify.post('/api/services/orders/:id/submit', async (request, reply) => {
    const order = stmts.getServiceOrder.get(request.params.id);
    if (!order) return reply.code(404).send({ error: 'Order not found' });
    if (order.status !== 'funded' && order.status !== 'in_progress') {
      return reply.code(400).send({ error: `Cannot submit in ${order.status} status` });
    }

    const { deliverable } = request.body || {};
    if (!deliverable) return reply.code(400).send({ error: 'deliverable required' });

    stmts.updateServiceOrderSubmit.run(deliverable, request.params.id);
    // Also update the linked job
    if (order.job_id) stmts.updateJobSubmit.run(deliverable, order.job_id);

    return { success: true, message: 'Deliverable submitted. Awaiting buyer approval.' };
  });

  // ═══════════════════════════════════════
  // APPROVE / REJECT (buyer reviews deliverable)
  // ═══════════════════════════════════════
  fastify.post('/api/services/orders/:id/approve', async (request, reply) => {
    const order = stmts.getServiceOrder.get(request.params.id);
    if (!order) return reply.code(404).send({ error: 'Order not found' });
    if (order.status !== 'submitted') {
      return reply.code(400).send({ error: 'Can only approve submitted orders' });
    }

    const { rating, review } = request.body || {};

    stmts.updateServiceOrderComplete.run(request.params.id);
    if (order.job_id) stmts.updateJobComplete.run('Approved by buyer', order.job_id);

    // Update rating if provided
    if (rating) stmts.updateServiceOrderReview.run(rating, review || null, request.params.id);

    // Update service stats
    stmts.completeServiceStats.run(order.price_lamports, order.service_id);

    return {
      success: true,
      message: 'Order approved! Funds released to provider.',
      escrow: {
        instruction: 'complete',
        note: 'Sign the complete transaction to release escrowed funds to the provider.',
      },
    };
  });

  fastify.post('/api/services/orders/:id/reject', async (request, reply) => {
    const order = stmts.getServiceOrder.get(request.params.id);
    if (!order) return reply.code(404).send({ error: 'Order not found' });
    if (order.status !== 'submitted') {
      return reply.code(400).send({ error: 'Can only reject submitted orders' });
    }

    const { reason } = request.body || {};
    stmts.updateServiceOrderStatus.run('rejected', request.params.id);
    if (order.job_id) stmts.updateJobReject.run(reason || 'Rejected by buyer', order.job_id);
    stmts.decrementServiceOrders.run(order.service_id);

    return {
      success: true,
      message: 'Order rejected. Buyer can claim refund.',
      escrow: {
        instruction: 'reject',
        note: 'Funds are available for refund via the reject/claim_refund instruction.',
      },
    };
  });

  // ═══════════════════════════════════════
  // LEAVE REVIEW
  // ═══════════════════════════════════════
  fastify.post('/api/services/orders/:id/review', async (request, reply) => {
    const order = stmts.getServiceOrder.get(request.params.id);
    if (!order) return reply.code(404).send({ error: 'Order not found' });
    if (order.status !== 'completed') return reply.code(400).send({ error: 'Can only review completed orders' });

    const { rating, review } = request.body || {};
    if (!rating || rating < 1 || rating > 5) return reply.code(400).send({ error: 'Rating must be 1-5' });

    stmts.updateServiceOrderReview.run(rating, review || null, request.params.id);
    return { success: true, message: 'Review submitted' };
  });
}
