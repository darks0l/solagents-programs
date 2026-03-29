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
 * 
 * Lifecycle enforcement:
 * - Budget > 0 required at creation
 * - on-chain address required before submit/complete
 * - funded state required before submit
 * - Expiry enforced on submit/complete
 * - 72h auto-release timer protects providers after submission
 * - 24h dispute window after completion before settlement
 */

const AUTO_RELEASE_HOURS = 72;
const DISPUTE_WINDOW_HOURS = 24;

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

/**
 * Check if a job is past its expiry and auto-mark it expired if so.
 * Mutates the job object in-place and updates DB.
 */
function checkAutoExpiry(job) {
  const now = Math.floor(Date.now() / 1000);
  if (['funded', 'submitted'].includes(job.status) && job.expired_at <= now) {
    job.can_claim_refund = true;
    job.expired_notice = 'Job has expired. Client can claim a refund.';
  }
  // Auto-mark settlement if completed and past dispute window
  if (job.status === 'completed' && job.completed_at && !job.settled_at && !job.dispute_status) {
    const settleTime = job.completed_at + (DISPUTE_WINDOW_HOURS * 3600);
    if (now >= settleTime) {
      stmts.updateJobSettledAt.run(now, job.id);
      job.settled_at = now;
    }
    job.dispute_window_ends = settleTime;
    job.can_dispute = now < settleTime;
  }
  // Auto-release check for submitted jobs
  if (job.status === 'submitted' && job.auto_release_at && now >= job.auto_release_at) {
    job.auto_releasable = true;
    job.auto_release_notice = 'Auto-release window has passed. Provider can claim payment via /auto-release.';
  }
  return job;
}

export default async function jobRoutes(fastify) {

  // === Admin: Reset Test Jobs ===
  fastify.post('/api/admin/reset-test-jobs', async (request, reply) => {
    const adminKey = process.env.ADMIN_KEY;
    if (!adminKey) return reply.code(503).send({ error: 'Admin endpoint not configured' });

    const { key } = request.body || {};
    if (key !== adminKey) return reply.code(403).send({ error: 'Invalid admin key' });

    const deleteResult = stmts.deleteTestJobs.run();
    const resetResult = stmts.resetAgentEarnings.run();

    return {
      success: true,
      deleted_jobs: deleteResult.changes,
      reset_agents: resetResult.changes,
      message: `Deleted ${deleteResult.changes} test job(s) and reset ${resetResult.changes} agent earning record(s)`,
    };
  });

  // === Create Job ===
  // Client creates a job posting. Sets provider at creation time (optional — can be null for open applications).
  // Returns instruction data for on-chain tx.
  fastify.post('/api/jobs/create', async (request, reply) => {
    const { client, provider, evaluator, expiredAt, description, hook, paymentMint, budget } = request.body;

    if (!client || !evaluator) {
      return reply.code(400).send({ error: 'client and evaluator are required' });
    }

    if (!description || description.length > 256) {
      return reply.code(400).send({ error: 'description required (max 256 chars)' });
    }

    if (!expiredAt || expiredAt <= Math.floor(Date.now() / 1000)) {
      return reply.code(400).send({ error: 'expiredAt must be a future unix timestamp' });
    }

    // Enforce budget > 0
    if (budget !== undefined && budget !== null && budget <= 0) {
      return reply.code(400).send({ error: 'budget must be greater than 0' });
    }

    // Build the on-chain transaction (returns base64 serialized tx)
    const { transaction, jobPDA, jobId: onchainJobId } = await commerce.buildCreateJobTransaction({
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
      budget || 0,
      expiredAt,
      hook || null,
      jobPDA, // on-chain address from PDA derivation
    );

    return {
      jobId: id,
      transaction,
      jobPDA,
      onchainJobId,
      message: 'Sign and submit this transaction to create the job on-chain. Then call POST /api/jobs/:jobId/confirm with txSignature.',
    };
  });

  // === Set Provider ===
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
  fastify.post('/api/jobs/:jobId/fund', async (request, reply) => {
    const { jobId } = request.params;
    const { expectedBudget, optParams } = request.body;

    const job = stmts.getJob.get(jobId);
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    if (job.status !== 'open') return reply.code(409).send({ error: 'Job must be in Open state' });
    if (!job.provider) return reply.code(409).send({ error: 'Provider must be set before funding' });
    if (job.budget <= 0) return reply.code(409).send({ error: 'Budget must be set and > 0 before funding' });

    const instruction = commerce.buildInstruction('fund', {
      expectedBudget: expectedBudget || job.budget,
      optParams,
    });

    stmts.updateJobStatus.run('pending_funded', jobId);

    return {
      jobId,
      instruction,
      message: 'Sign and submit this transaction, then call POST /api/jobs/:jobId/confirm with txSignature',
    };
  });

  // === Submit Deliverable ===
  fastify.post('/api/jobs/:jobId/submit', async (request, reply) => {
    const { jobId } = request.params;
    const { deliverable, optParams } = request.body;

    if (!deliverable) {
      return reply.code(400).send({ error: 'deliverable hash required (32 bytes hex)' });
    }

    const job = stmts.getJob.get(jobId);
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    if (job.status !== 'funded') return reply.code(409).send({ error: 'Job must be in Funded state' });

    // Enforce on-chain escrow exists
    if (!job.onchain_address) {
      return reply.code(409).send({ error: 'Job must have on-chain escrow address before submission. Fund the job on-chain first.' });
    }

    // Enforce deadline
    const now = Math.floor(Date.now() / 1000);
    if (job.expired_at <= now) {
      return reply.code(409).send({ error: 'Job has expired. Cannot submit after expiry.' });
    }

    const instruction = commerce.buildInstruction('submit', { deliverable, optParams });

    stmts.updateJobStatus.run('pending_submitted', jobId);
    stmts.updateJobSubmit.run(deliverable, jobId);

    return {
      jobId,
      instruction,
      message: 'Sign and submit this transaction, then call POST /api/jobs/:jobId/confirm with txSignature',
    };
  });

  // === Complete (Evaluator) ===
  fastify.post('/api/jobs/:jobId/complete', async (request, reply) => {
    const { jobId } = request.params;
    const { reason, optParams } = request.body;

    const job = stmts.getJob.get(jobId);
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    if (job.status !== 'submitted') return reply.code(409).send({ error: 'Job must be in Submitted state' });

    // Enforce on-chain escrow
    if (!job.onchain_address) {
      return reply.code(409).send({ error: 'Job must have on-chain escrow address. Cannot complete a job with no on-chain backing.' });
    }

    // Enforce funded state was reached (funded_at must be set)
    if (!job.funded_at) {
      return reply.code(409).send({ error: 'Job must have been funded on-chain before completion.' });
    }

    // Enforce deadline
    const now = Math.floor(Date.now() / 1000);
    if (job.expired_at <= now) {
      return reply.code(409).send({ error: 'Job has expired. Cannot complete after expiry. Use refund endpoint.' });
    }

    const instruction = commerce.buildInstruction('complete', { reason, optParams });

    stmts.updateJobStatus.run('pending_completed', jobId);

    return {
      jobId,
      instruction,
      message: 'Sign and submit this transaction, then call POST /api/jobs/:jobId/confirm with txSignature',
    };
  });

  // === Reject ===
  fastify.post('/api/jobs/:jobId/reject', async (request, reply) => {
    const { jobId } = request.params;
    const { reason, optParams } = request.body;

    const job = stmts.getJob.get(jobId);
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    if (!['open', 'funded', 'submitted'].includes(job.status)) {
      return reply.code(409).send({ error: 'Job cannot be rejected in current state' });
    }

    const instruction = commerce.buildInstruction('reject', { reason, optParams });
    stmts.updateJobStatus.run('pending_rejected', jobId);

    return {
      jobId,
      instruction,
      message: 'Sign and submit this transaction, then call POST /api/jobs/:jobId/confirm with txSignature',
    };
  });

  // === Claim Refund (Expired) ===
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
    stmts.updateJobStatus.run('pending_expired', jobId);

    return {
      jobId,
      instruction,
      message: 'Sign and submit this transaction, then call POST /api/jobs/:jobId/confirm with txSignature',
    };
  });

  // === Auto-Release (72h provider protection) ===
  fastify.post('/api/jobs/:jobId/auto-release', async (request, reply) => {
    const { jobId } = request.params;

    const job = stmts.getJob.get(jobId);
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    if (job.status !== 'submitted') {
      return reply.code(409).send({ error: 'Job must be in Submitted state for auto-release' });
    }
    if (!job.auto_release_at) {
      return reply.code(409).send({ error: 'Job has no auto-release timer set' });
    }

    const now = Math.floor(Date.now() / 1000);
    if (now < job.auto_release_at) {
      const remaining = job.auto_release_at - now;
      const hours = Math.ceil(remaining / 3600);
      return reply.code(409).send({
        error: `Auto-release window has not passed yet. ${hours}h remaining.`,
        auto_release_at: job.auto_release_at,
      });
    }

    // Auto-complete: build the complete instruction
    const instruction = commerce.buildInstruction('complete', {
      reason: 'Auto-released: evaluator did not respond within 72 hours',
    });

    stmts.updateJobStatus.run('pending_completed', jobId);

    return {
      jobId,
      instruction,
      auto_released: true,
      message: 'Auto-release window passed. Sign to complete the job and release payment to provider.',
    };
  });

  // === Dispute (24h window after completion) ===
  fastify.post('/api/jobs/:jobId/dispute', async (request, reply) => {
    const { jobId } = request.params;
    const { raisedBy, reason } = request.body || {};

    if (!raisedBy || !reason) {
      return reply.code(400).send({ error: 'raisedBy (wallet address) and reason are required' });
    }

    const job = stmts.getJob.get(jobId);
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    if (job.status !== 'completed') {
      return reply.code(409).send({ error: 'Disputes can only be raised on completed jobs' });
    }
    if (job.settled_at) {
      return reply.code(409).send({ error: 'Job has already settled. Dispute window has passed.' });
    }
    if (job.dispute_status === 'open') {
      return reply.code(409).send({ error: 'A dispute is already open for this job' });
    }

    // Check dispute window
    const now = Math.floor(Date.now() / 1000);
    const disputeDeadline = (job.completed_at || 0) + (DISPUTE_WINDOW_HOURS * 3600);
    if (now > disputeDeadline) {
      return reply.code(409).send({ error: 'Dispute window has expired (24h after completion)' });
    }

    // Verify raisedBy is client or provider
    if (raisedBy !== job.client && raisedBy !== job.provider) {
      return reply.code(403).send({ error: 'Only the client or provider can raise a dispute' });
    }

    // Check for existing open dispute
    const existing = stmts.getOpenDispute.get(jobId);
    if (existing) {
      return reply.code(409).send({ error: 'A dispute is already open for this job' });
    }

    const disputeId = uuid();
    stmts.insertDispute.run(disputeId, jobId, raisedBy, reason);
    stmts.updateJobDisputeStatus.run('open', jobId);

    return {
      disputeId,
      jobId,
      status: 'open',
      message: 'Dispute filed. Funds are frozen until resolved.',
    };
  });

  // === Confirm Transaction ===
  fastify.post('/api/jobs/:jobId/confirm', async (request, reply) => {
    const { jobId } = request.params;
    const { txSignature, onchainAddress } = request.body;

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

    // State-specific side effects
    if (finalState === 'funded') {
      stmts.updateJobFundedAt.run(jobId);
      // Record on-chain address if provided
      if (onchainAddress && !job.onchain_address) {
        stmts.updateJobOnchain.run(onchainAddress, null, jobId);
      }
    }

    if (finalState === 'submitted') {
      // Start 72h auto-release timer
      const autoReleaseAt = Math.floor(Date.now() / 1000) + (AUTO_RELEASE_HOURS * 3600);
      stmts.updateJobSubmittedAt.run(autoReleaseAt, jobId);
    }

    if (finalState === 'completed') {
      // Record completed_at and update agent stats
      stmts.updateJobComplete.run(null, jobId);

      // Update agent stats if provider is a registered agent
      if (job.provider) {
        try {
          const agentStats = stmts.getAgentStats.get(job.provider);
          if (agentStats) {
            const newCompleted = (agentStats.completed_jobs || 0) + 1;
            const newTotal = (agentStats.total_jobs || 0) + 1;
            const newEarned = (parseFloat(agentStats.total_earned || '0') + (job.budget || 0)).toString();
            const newRate = newTotal > 0 ? newCompleted / newTotal : 0;
            stmts.upsertAgentStats.run(
              job.provider, newTotal, newCompleted, agentStats.rejected_jobs || 0,
              newEarned, newRate, agentStats.token_id || null
            );
          }
        } catch { /* non-critical */ }
      }
    }

    return {
      jobId,
      status: finalState,
      txSignature,
      message: `Job advanced to ${finalState}`,
      ...(finalState === 'submitted' && { auto_release_at: Math.floor(Date.now() / 1000) + (AUTO_RELEASE_HOURS * 3600) }),
      ...(finalState === 'completed' && { dispute_window_ends: Math.floor(Date.now() / 1000) + (DISPUTE_WINDOW_HOURS * 3600) }),
    };
  });

  // === Get Job ===
  fastify.get('/api/jobs/:jobId', async (request, reply) => {
    const job = stmts.getJob.get(request.params.jobId);
    if (!job) return reply.code(404).send({ error: 'Job not found' });

    return checkAutoExpiry(job);
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

    // Apply auto-expiry and settlement checks
    for (const job of jobs) {
      checkAutoExpiry(job);
    }

    return { jobs, count: jobs.length };
  });

  // === Job Stats ===
  fastify.get('/api/jobs/stats', async () => {
    const stats = stmts.jobStats.get();
    return stats;
  });
}
