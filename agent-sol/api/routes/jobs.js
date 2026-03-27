import { v4 as uuid } from 'uuid';
import { stmts } from '../services/db.js';
import * as commerce from '../services/commerce.js';
import { connection } from '../services/commerce.js';

/**
 * Jobs routes — REST API for the Agentic Commerce Protocol (EIP-8183 on Solana).
 * 
 * The API serves as an indexer + instruction builder.
 * On-chain state is the source of truth; the DB caches job metadata for fast queries.
 * Clients sign transactions locally — we never hold private keys.
 * 
 * TX Verification Pattern:
 * State-advancing routes (fund, submit, complete, reject, refund) return an Anchor
 * instruction for the client to sign. On success they mark the DB record as
 * `pending_<nextState>`. The client submits the tx and then calls:
 *   POST /api/jobs/:jobId/confirm  { txSignature }
 * which verifies the tx on-chain and advances the DB to the final state.
 */

/**
 * Verify a Solana transaction was confirmed on-chain.
 * Returns true if the tx exists and succeeded (meta.err === null).
 */
async function verifyTx(signature) {
  try {
    const tx = await connection.getTransaction(signature, { commitment: 'confirmed' });
    if (!tx) return false;
    if (tx.meta && tx.meta.err !== null) return false;
    return true;
  } catch {
    return false;
  }
}

export default async function jobRoutes(fastify) {
  // === Create Job ===
  // Client creates a job posting. Sets provider at creation time (optional — can be null for open applications).
  // Returns instruction data for on-chain tx.
  fastify.post('/api/jobs/create', async (request, reply) => {
    const { client, provider, evaluator, expiredAt, description, hook, paymentMint } = request.body;

    if (!client || !evaluator) {
      return reply.code(400).send({ error: 'client and evaluator are required' });
    }

    if (!description || description.length > 256) {
      return reply.code(400).send({ error: 'description required (max 256 chars)' });
    }

    if (!expiredAt || expiredAt <= Math.floor(Date.now() / 1000)) {
      return reply.code(400).send({ error: 'expiredAt must be a future unix timestamp' });
    }

    // Build the on-chain instruction
    const instruction = commerce.buildCreateJobTx({
      client,
      provider,
      evaluator,
      expiredAt,
      description,
      hook,
      paymentMint,
    });

    // Store in local DB for indexing (pending until confirmed on-chain)
    const id = uuid();
    stmts.insertJob.run(
      id,
      client,
      provider || null,
      evaluator,
      description,
      0, // budget (not set yet)
      expiredAt,
      hook || null,
      null, // on-chain address (set after confirmation)
    );

    return {
      jobId: id,
      instruction,
      message: 'Sign and submit this transaction to create the job on-chain',
    };
  });

  // === Set Provider ===
  // Reassigns the provider on an existing job (e.g., original provider dropped out).
  // NOTE: create_job sets the initial provider. Use set_provider ONLY to reassign a
  // different provider after job creation. Returns ProviderAlreadySet if a provider
  // is already assigned and you are not changing it to a new one.
  fastify.post('/api/jobs/:jobId/provider', async (request, reply) => {
    const { jobId } = request.params;
    const { provider, optParams } = request.body;

    if (!provider) {
      return reply.code(400).send({ error: 'provider address required' });
    }

    const job = stmts.getJob.get(jobId);
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    if (job.status !== 'open') return reply.code(409).send({ error: 'Job must be in Open state to reassign provider' });
    if (job.provider && job.provider === provider) {
      return reply.code(409).send({
        error: 'ProviderAlreadySet: this provider is already assigned. Use set_provider to reassign a different provider.',
      });
    }

    const instruction = commerce.buildInstruction('set_provider', { provider, optParams });

    // Update local index
    stmts.updateJobProvider.run(provider, jobId);

    return { jobId, instruction, message: 'Sign to reassign provider on-chain' };
  });

  // === Set Budget ===
  fastify.post('/api/jobs/:jobId/budget', async (request, reply) => {
    const { jobId } = request.params;
    const { amount, optParams } = request.body;

    if (!amount || amount <= 0) {
      return reply.code(400).send({ error: 'amount must be positive' });
    }

    const job = stmts.getJob.get(jobId);
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    if (job.status !== 'open') return reply.code(409).send({ error: 'Job must be in Open state' });

    const instruction = commerce.buildInstruction('set_budget', { amount, optParams });

    stmts.updateJobBudget.run(amount, jobId);

    return { jobId, instruction, message: 'Sign to set budget on-chain' };
  });

  // === Fund Job ===
  // Returns the fund instruction. DB is marked pending_funded.
  // Call POST /api/jobs/:jobId/confirm with txSignature after the tx lands.
  fastify.post('/api/jobs/:jobId/fund', async (request, reply) => {
    const { jobId } = request.params;
    const { expectedBudget, optParams } = request.body;

    const job = stmts.getJob.get(jobId);
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    if (job.status !== 'open') return reply.code(409).send({ error: 'Job must be in Open state' });
    if (!job.provider) return reply.code(409).send({ error: 'Provider must be set before funding' });
    if (job.budget <= 0) return reply.code(409).send({ error: 'Budget must be set before funding' });

    const instruction = commerce.buildInstruction('fund', {
      expectedBudget: expectedBudget || job.budget,
      optParams,
    });

    // Mark pending — DB will advance to 'funded' once /confirm verifies the tx on-chain
    stmts.updateJobStatus.run('pending_funded', jobId);

    return {
      jobId,
      instruction,
      message: 'Sign and submit this transaction, then call POST /api/jobs/:jobId/confirm with txSignature',
    };
  });

  // === Submit Deliverable ===
  // Returns the submit instruction. DB is marked pending_submitted.
  // Call POST /api/jobs/:jobId/confirm with txSignature after the tx lands.
  fastify.post('/api/jobs/:jobId/submit', async (request, reply) => {
    const { jobId } = request.params;
    const { deliverable, optParams } = request.body;

    if (!deliverable) {
      return reply.code(400).send({ error: 'deliverable hash required (32 bytes hex)' });
    }

    const job = stmts.getJob.get(jobId);
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    if (job.status !== 'funded') return reply.code(409).send({ error: 'Job must be in Funded state' });

    const instruction = commerce.buildInstruction('submit', { deliverable, optParams });

    // Mark pending — DB will advance to 'submitted' once /confirm verifies the tx on-chain
    stmts.updateJobStatus.run('pending_submitted', jobId);
    // Store the deliverable for later
    stmts.updateJobSubmit.run(deliverable, jobId);

    return {
      jobId,
      instruction,
      message: 'Sign and submit this transaction, then call POST /api/jobs/:jobId/confirm with txSignature',
    };
  });

  // === Complete (Evaluator) ===
  // Returns the complete instruction. DB is marked pending_completed.
  // Call POST /api/jobs/:jobId/confirm with txSignature after the tx lands.
  fastify.post('/api/jobs/:jobId/complete', async (request, reply) => {
    const { jobId } = request.params;
    const { reason, optParams } = request.body;

    const job = stmts.getJob.get(jobId);
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    if (job.status !== 'submitted') return reply.code(409).send({ error: 'Job must be in Submitted state' });

    const instruction = commerce.buildInstruction('complete', { reason, optParams });

    // Mark pending — DB will advance to 'completed' once /confirm verifies the tx on-chain
    stmts.updateJobStatus.run('pending_completed', jobId);

    return {
      jobId,
      instruction,
      message: 'Sign and submit this transaction, then call POST /api/jobs/:jobId/confirm with txSignature',
    };
  });

  // === Reject ===
  // Returns the reject instruction. DB is marked pending_rejected.
  // Call POST /api/jobs/:jobId/confirm with txSignature after the tx lands.
  fastify.post('/api/jobs/:jobId/reject', async (request, reply) => {
    const { jobId } = request.params;
    const { reason, optParams } = request.body;

    const job = stmts.getJob.get(jobId);
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    if (!['open', 'funded', 'submitted'].includes(job.status)) {
      return reply.code(409).send({ error: 'Job cannot be rejected in current state' });
    }

    const instruction = commerce.buildInstruction('reject', { reason, optParams });

    // Mark pending — DB will advance to 'rejected' once /confirm verifies the tx on-chain
    stmts.updateJobStatus.run('pending_rejected', jobId);

    return {
      jobId,
      instruction,
      message: 'Sign and submit this transaction, then call POST /api/jobs/:jobId/confirm with txSignature',
    };
  });

  // === Claim Refund (Expired) ===
  // Returns the claim_refund instruction. DB is marked pending_expired.
  // Call POST /api/jobs/:jobId/confirm with txSignature after the tx lands.
  fastify.post('/api/jobs/:jobId/refund', async (request, reply) => {
    const { jobId } = request.params;

    const job = stmts.getJob.get(jobId);
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    if (!['funded', 'submitted'].includes(job.status)) {
      return reply.code(409).send({ error: 'Job must be Funded or Submitted' });
    }
    if (job.expired_at > Math.floor(Date.now() / 1000)) {
      return reply.code(409).send({ error: 'Job has not expired yet' });
    }

    const instruction = commerce.buildInstruction('claim_refund', {});

    // Mark pending — DB will advance to 'expired' once /confirm verifies the tx on-chain
    stmts.updateJobStatus.run('pending_expired', jobId);

    return {
      jobId,
      instruction,
      message: 'Sign and submit this transaction, then call POST /api/jobs/:jobId/confirm with txSignature',
    };
  });

  // === Confirm Transaction ===
  // Verifies a Solana transaction on-chain and advances the DB state from pending_* to final.
  // Call this after the client has signed and submitted the instruction from a state-advancing route.
  fastify.post('/api/jobs/:jobId/confirm', async (request, reply) => {
    const { jobId } = request.params;
    const { txSignature } = request.body;

    if (!txSignature) {
      return reply.code(400).send({ error: 'txSignature required' });
    }

    const job = stmts.getJob.get(jobId);
    if (!job) return reply.code(404).send({ error: 'Job not found' });

    // Map pending_* → final state
    const pendingToFinal = {
      pending_funded: 'funded',
      pending_submitted: 'submitted',
      pending_completed: 'completed',
      pending_rejected: 'rejected',
      pending_expired: 'expired',
    };

    const finalState = pendingToFinal[job.status];
    if (!finalState) {
      return reply.code(409).send({
        error: `Job is not in a pending state (current: ${job.status}). Only call /confirm after a state-advancing action.`,
      });
    }

    // Verify the transaction was confirmed on-chain
    const confirmed = await verifyTx(txSignature);
    if (!confirmed) {
      return reply.code(400).send({
        error: 'Transaction not confirmed on-chain. Ensure the tx has landed before calling /confirm.',
        txSignature,
      });
    }

    // Advance DB to final state
    stmts.updateJobStatus.run(finalState, jobId);

    return {
      jobId,
      status: finalState,
      txSignature,
      message: `Job advanced to ${finalState}`,
    };
  });

  // === Get Job ===
  fastify.get('/api/jobs/:jobId', async (request, reply) => {
    const job = stmts.getJob.get(request.params.jobId);
    if (!job) return reply.code(404).send({ error: 'Job not found' });

    // Check if expired but not yet claimed
    if (['funded', 'submitted'].includes(job.status) && job.expired_at <= Math.floor(Date.now() / 1000)) {
      job.can_claim_refund = true;
    }

    return job;
  });

  // === List Jobs ===
  fastify.get('/api/jobs', async (request) => {
    const { status, client, provider, evaluator, limit = 50, offset = 0 } = request.query;

    let jobs;
    if (status) {
      jobs = stmts.listJobsByStatus.all(status, parseInt(limit), parseInt(offset));
    } else if (client) {
      jobs = stmts.listJobsByClient.all(client, parseInt(limit), parseInt(offset));
    } else if (provider) {
      jobs = stmts.listJobsByProvider.all(provider, parseInt(limit), parseInt(offset));
    } else {
      jobs = stmts.listAllJobs.all(parseInt(limit), parseInt(offset));
    }

    // Mark refund-claimable
    const now = Math.floor(Date.now() / 1000);
    for (const job of jobs) {
      if (['funded', 'submitted'].includes(job.status) && job.expired_at <= now) {
        job.can_claim_refund = true;
      }
    }

    return { jobs, count: jobs.length };
  });

  // === Job Stats ===
  fastify.get('/api/jobs/stats', async () => {
    const stats = stmts.jobStats.get();
    return stats;
  });
}
