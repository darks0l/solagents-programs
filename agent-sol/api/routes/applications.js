import { randomUUID } from 'crypto';
import { stmts } from '../services/db.js';

const LAMPORTS_PER_SOL = 1_000_000_000;
const lamportsToSol = (l) => (Number(l) / LAMPORTS_PER_SOL).toFixed(4);

export default async function applicationRoutes(fastify) {

  // ═══════════════════════════════════════
  // APPLY TO JOB (agent submits proposal)
  // ═══════════════════════════════════════
  fastify.post('/api/jobs/:jobId/apply', async (request, reply) => {
    const job = stmts.getJob.get(request.params.jobId);
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    if (job.status !== 'open' && job.status !== 'funded') {
      return reply.code(400).send({ error: `Cannot apply to ${job.status} jobs` });
    }
    if (job.provider && job.provider !== '11111111111111111111111111111111') {
      return reply.code(400).send({ error: 'Job already has a provider assigned' });
    }

    const { applicantWallet, agentId, proposal, priceSol, estimatedHours } = request.body || {};

    if (!applicantWallet || !proposal) {
      return reply.code(400).send({ error: 'applicantWallet and proposal required' });
    }

    if (applicantWallet === job.client) {
      return reply.code(400).send({ error: 'Cannot apply to your own job' });
    }

    const id = `app_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const priceLamports = priceSol ? Math.round(Number(priceSol) * LAMPORTS_PER_SOL) : null;

    try {
      stmts.insertApplication.run(
        id, request.params.jobId, applicantWallet, agentId || null,
        proposal, priceLamports, estimatedHours || null
      );
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        return reply.code(409).send({ error: 'You already applied to this job' });
      }
      throw err;
    }

    return {
      applicationId: id,
      jobId: request.params.jobId,
      message: 'Application submitted successfully. The job poster will review your proposal.',
    };
  });

  // ═══════════════════════════════════════
  // LIST APPLICATIONS FOR A JOB (poster views)
  // ═══════════════════════════════════════
  fastify.get('/api/jobs/:jobId/applications', async (request) => {
    const { status = 'pending' } = request.query;
    const applications = stmts.listApplicationsByJob.all(request.params.jobId, status);
    return {
      applications: applications.map(a => ({
        ...a,
        price_sol: a.price_lamports ? lamportsToSol(a.price_lamports) : null,
        agent_capabilities: a.agent_capabilities ? JSON.parse(a.agent_capabilities) : [],
      })),
    };
  });

  // ═══════════════════════════════════════
  // MY APPLICATIONS (agent views own)
  // ═══════════════════════════════════════
  fastify.get('/api/applications/wallet/:wallet', async (request) => {
    const { limit = 50, offset = 0 } = request.query;
    const applications = stmts.listApplicationsByAgent.all(
      request.params.wallet, Number(limit), Number(offset)
    );
    return {
      applications: applications.map(a => ({
        ...a,
        price_sol: a.price_lamports ? lamportsToSol(a.price_lamports) : null,
      })),
    };
  });

  // ═══════════════════════════════════════
  // ACCEPT APPLICATION (poster picks an agent)
  // ═══════════════════════════════════════
  fastify.post('/api/jobs/:jobId/applications/:appId/accept', async (request, reply) => {
    const job = stmts.getJob.get(request.params.jobId);
    if (!job) return reply.code(404).send({ error: 'Job not found' });

    const application = stmts.getApplication.get(request.params.appId);
    if (!application) return reply.code(404).send({ error: 'Application not found' });
    if (application.job_id !== request.params.jobId) {
      return reply.code(400).send({ error: 'Application does not belong to this job' });
    }
    if (application.status !== 'pending') {
      return reply.code(400).send({ error: `Application is ${application.status}` });
    }

    // Accept this application
    stmts.updateApplicationStatus.run('accepted', request.params.appId);

    // Reject all other pending applications
    stmts.rejectOtherApplications.run(request.params.jobId, request.params.appId);

    // Set provider on the job
    stmts.updateJobProvider.run(application.applicant_wallet, request.params.jobId);

    // If applicant proposed a price, update job budget
    if (application.price_lamports) {
      stmts.updateJobBudget.run(application.price_lamports, request.params.jobId);
    }

    return {
      success: true,
      message: `${application.agent_name || application.applicant_wallet} accepted as provider.`,
      escrow: {
        programId: 'Ddpj5GCjz8jFuBQXopUfzxkAmkWPCCwC7mhpL6SY9fdx',
        instruction: 'set_provider',
        provider: application.applicant_wallet,
        note: 'Sign the set_provider transaction on-chain, then fund the escrow.',
      },
    };
  });

  // ═══════════════════════════════════════
  // REJECT APPLICATION
  // ═══════════════════════════════════════
  fastify.post('/api/jobs/:jobId/applications/:appId/reject', async (request, reply) => {
    const application = stmts.getApplication.get(request.params.appId);
    if (!application) return reply.code(404).send({ error: 'Application not found' });
    if (application.status !== 'pending') {
      return reply.code(400).send({ error: `Application is ${application.status}` });
    }

    stmts.updateApplicationStatus.run('rejected', request.params.appId);
    return { success: true, message: 'Application rejected' };
  });

  // ═══════════════════════════════════════
  // WITHDRAW APPLICATION (agent pulls own)
  // ═══════════════════════════════════════
  fastify.post('/api/jobs/:jobId/applications/:appId/withdraw', async (request, reply) => {
    const application = stmts.getApplication.get(request.params.appId);
    if (!application) return reply.code(404).send({ error: 'Application not found' });
    if (application.status !== 'pending') {
      return reply.code(400).send({ error: `Cannot withdraw ${application.status} application` });
    }

    stmts.updateApplicationStatus.run('withdrawn', request.params.appId);
    return { success: true, message: 'Application withdrawn' };
  });
}
