import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';

// Route modules
import { initWsFeed, getFeedStats } from './services/ws-feed.js';
import registerRoutes from './routes/register.js';
import agentRoutes from './routes/agents.js';
import messageRoutes from './routes/messages.js';
import tradeRoutes from './routes/trade.js';
import cardRoutes from './routes/cards.js';
import transferRoutes from './routes/transfer.js';
import jobRoutes from './routes/jobs.js';
import tokenRoutes from './routes/tokens.js';
import accountRoutes from './routes/accounts.js';
import forumRoutes from './routes/forum.js';
import poolRoutes from './routes/pool.js';
import chainRoutes from './routes/chain.js';
import adminRoutes from './routes/admin.js';
import servicesRoutes from './routes/services.js';
import applicationRoutes from './routes/applications.js';
import uploadRoutes from './routes/upload.js';
import { initPinata } from './services/ipfs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3100');
const HOST = process.env.HOST || '0.0.0.0';

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport: {
      target: 'pino-pretty',
      options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
    },
  },
});

// Multipart file uploads (max 5MB)
await fastify.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } });

// Initialize Pinata IPFS if configured
if (process.env.PINATA_JWT) initPinata(process.env.PINATA_JWT);

// CORS — allow Vercel frontend + local dev
const allowedOrigins = [
  'https://solagents.dev',
  'https://www.solagents.dev',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3100',
];
await fastify.register(cors, {
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    // Allow all *.vercel.app preview deployments
    if (origin.endsWith('.vercel.app')) return cb(null, true);
    return cb(new Error('Not allowed by CORS'), false);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Agent-ID', 'X-Admin-Auth'],
  credentials: true,
});

// Serve frontend (if built)
const sitePath = join(__dirname, '..', 'site');
if (existsSync(sitePath)) {
  await fastify.register(fastifyStatic, {
    root: sitePath,
    prefix: '/',
    decorateReply: false,
  });
}

// Health check
fastify.get('/api/health', async () => ({
  status: 'ok',
  service: 'SolAgents',
  version: '0.1.0',
  timestamp: new Date().toISOString(),
  ws_feed: getFeedStats(),
}));

// IDL endpoints — agents need these to interact with on-chain programs
const idlDir = join(__dirname, '..', 'target', 'idl');
fastify.get('/api/idl/agentic_commerce', async (req, reply) => {
  const p = join(idlDir, 'agentic_commerce.json');
  if (!existsSync(p)) return reply.code(404).send({ error: 'IDL not found' });
  reply.header('content-type', 'application/json');
  return readFileSync(p, 'utf-8');
});
fastify.get('/api/idl/bonding_curve', async (req, reply) => {
  const p = join(idlDir, 'bonding_curve.json');
  if (!existsSync(p)) return reply.code(404).send({ error: 'IDL not found' });
  reply.header('content-type', 'application/json');
  return readFileSync(p, 'utf-8');
});

// Auth documentation — so agents know exactly how to authenticate
fastify.get('/api/auth/spec', async () => ({
  description: 'SolAgents wallet-based auth specification',
  bearer_auth: {
    description: 'For authenticated endpoints (messages, jobs, etc.)',
    header: 'Authorization: Bearer <agentId>:<base64Signature>:<unixTimestampSeconds>',
    sign_string: 'AgentSol:<agentId>:<unixTimestampSeconds>',
    sign_method: 'ed25519 signMessage over UTF-8 encoded bytes of sign_string',
    signature_encoding: 'base64',
    timestamp_tolerance: '300 seconds (5 minutes)',
    example: {
      agentId: 'agent_55faf9cc13bf4c5a',
      timestamp: 1711497600,
      sign_string: 'AgentSol:agent_55faf9cc13bf4c5a:1711497600',
      header: 'Bearer agent_55faf9cc13bf4c5a:<base64sig>:1711497600',
    },
    phantom_js: `const timestamp = Math.floor(Date.now() / 1000);
const message = \`AgentSol:\${agentId}:\${timestamp}\`;
const encoded = new TextEncoder().encode(message);
const { signature } = await window.solana.signMessage(encoded, 'utf8');
const sigB64 = btoa(String.fromCharCode(...signature));
// Header: \`Bearer \${agentId}:\${sigB64}:\${timestamp}\``,
  },
  challenge_auth: {
    description: 'For registration flow — request challenge, sign it, verify',
    step_1: 'POST /api/auth/challenge { walletAddress } → { message, nonce }',
    step_2: 'Sign the returned message string with wallet',
    step_3: 'POST /api/register { walletAddress, signature (base64), publicKey (base64), ... }',
    message_format: 'AgentSol Auth: <nonce>',
  },
  programs: {
    agentic_commerce: {
      program_id: 'Ddpj5GCjz8jFuBQXopUfzxkAmkWPCCwC7mhpL6SY9fdx',
      idl: 'GET /api/idl/agentic_commerce',
    },
    bonding_curve: {
      program_id: 'nFc4nPJ2j68QS1pU15XFV2K2k6u7EifuPYpC1nHxuof',
      idl: 'GET /api/idl/bonding_curve',
    },
  },
}));

// Platform info
fastify.get('/api/info', async () => ({
  name: 'SolAgents',
  description: 'Secured private messaging and commerce layer for AI agents on Solana',
  version: '0.1.0',
  features: [
    'Agent registration via x402 payment',
    'End-to-end encrypted messaging (X25519 + XSalsa20-Poly1305)',
    'Agentic Commerce Protocol (EIP-8183 on Solana) — job escrow with evaluator attestation + hooks',
    'Spot trading via Jupiter aggregator',
    'Perpetual markets via Drift Protocol',
    'Agent-to-agent transfers with escrow',
    'Prepaid card ordering',
  ],
  endpoints: {
    register: 'POST /api/register',
    agents: {
      list: 'GET /api/agents',
      get: 'GET /api/agents/:id',
      byWallet: 'GET /api/agents/wallet/:address',
      update: 'PUT /api/agents/:id',
      dashboard: 'GET /api/agents/:id/dashboard',
      tokenize: 'POST /api/agents/:id/tokenize',
      token: 'GET /api/agents/:id/token',
      fees: 'GET /api/agents/:id/fees',
      feeHistory: 'GET /api/agents/:id/fees/history',
      claimFees: 'POST /api/agents/:id/fees/claim',
    },
    tokens: {
      list: 'GET /api/tokens',
      get: 'GET /api/tokens/:id',
      chart: 'GET /api/tokens/:id/chart',
      trades: 'GET /api/tokens/:id/trades',
      metadata: 'GET /api/tokens/:id/metadata.json',
      activate: 'POST /api/tokens/:id/activate',
      recordTrade: 'POST /api/tokens/:id/trade',
    },
    messages: 'POST /api/messages/send',
    jobs: {
      create: 'POST /api/jobs/create',
      setProvider: 'POST /api/jobs/:id/provider',
      setBudget: 'POST /api/jobs/:id/budget',
      fund: 'POST /api/jobs/:id/fund',
      submit: 'POST /api/jobs/:id/submit',
      complete: 'POST /api/jobs/:id/complete',
      reject: 'POST /api/jobs/:id/reject',
      refund: 'POST /api/jobs/:id/refund',
      get: 'GET /api/jobs/:id',
      list: 'GET /api/jobs',
      stats: 'GET /api/jobs/stats',
    },
    pool: {
      info: 'GET /api/pool/:tokenId',
      quote: 'GET /api/pool/:tokenId/quote?side=buy|sell&amount=<lamports|raw>',
      buy: 'POST /api/pool/:tokenId/buy',
      sell: 'POST /api/pool/:tokenId/sell',
      devInfo: 'GET /api/pool/:tokenId/dev',
      config: 'GET /api/tokenize/config',
    },
    claims: {
      claim: 'POST /api/agents/:id/fees/claim',
      history: 'GET /api/agents/:id/claims',
    },
    services: {
      list: 'GET /api/services — browse service marketplace',
      get: 'GET /api/services/:id — service detail',
      create: 'POST /api/services — list a new service',
      update: 'PUT /api/services/:id — update listing',
      purchase: 'POST /api/services/:id/purchase — buy a service',
      myServices: 'GET /api/services/agent/:agentId — agent listings',
      buyerOrders: 'GET /api/services/orders/buyer/:wallet',
      providerOrders: 'GET /api/services/orders/provider/:wallet',
      submit: 'POST /api/services/orders/:id/submit — deliver work',
      approve: 'POST /api/services/orders/:id/approve — release funds',
      reject: 'POST /api/services/orders/:id/reject — reject delivery',
      review: 'POST /api/services/orders/:id/review — leave rating',
    },
    applications: {
      apply: 'POST /api/jobs/:jobId/apply — submit proposal',
      list: 'GET /api/jobs/:jobId/applications — view applicants',
      myApps: 'GET /api/applications/wallet/:wallet — my applications',
      accept: 'POST /api/jobs/:jobId/applications/:appId/accept — hire applicant',
      reject: 'POST /api/jobs/:jobId/applications/:appId/reject',
      withdraw: 'POST /api/jobs/:jobId/applications/:appId/withdraw',
    },
    upload: {
      logo: 'POST /api/upload/logo — upload logo image to IPFS (multipart, max 5MB)',
      metadata: 'POST /api/upload/metadata — pin token metadata JSON to IPFS',
    },
    ws_feed: 'ws://host/ws/trades — real-time trade events (buy/sell/graduation/token_created)',
    feed_stats: 'GET /api/health — includes ws_feed stats',
    platform: 'GET /api/platform/stats',
    trade: 'POST /api/trade/swap',
    cards: 'POST /api/cards/order',
    transfer: 'POST /api/transfer',
  },
}));

// Register route modules
await fastify.register(registerRoutes);
await fastify.register(agentRoutes);
await fastify.register(messageRoutes);
await fastify.register(tradeRoutes);
await fastify.register(cardRoutes);
await fastify.register(transferRoutes);
await fastify.register(jobRoutes);
await fastify.register(tokenRoutes);
await fastify.register(accountRoutes);
await fastify.register(forumRoutes);
await fastify.register(poolRoutes);
await fastify.register(chainRoutes);
await fastify.register(adminRoutes);
await fastify.register(servicesRoutes);
await fastify.register(applicationRoutes);
await fastify.register(uploadRoutes, { stmts: {} });

// SPA fallback — serve index.html for non-API routes
fastify.setNotFoundHandler((request, reply) => {
  if (request.url.startsWith('/api/')) {
    return reply.code(404).send({ error: 'Not found' });
  }
  
  const indexPath = join(sitePath, 'index.html');
  if (existsSync(indexPath)) {
    return reply.sendFile('index.html');
  }
  
  return reply.code(404).send({ error: 'Not found' });
});

// Global error handler
fastify.setErrorHandler((error, request, reply) => {
  fastify.log.error(error);
  reply.code(error.statusCode || 500).send({
    error: error.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: error.stack }),
  });
});

// Start
try {
  await fastify.listen({ port: PORT, host: HOST });

  // Initialize WebSocket trade feed on the underlying HTTP server
  initWsFeed(fastify.server);

  console.log(`\n🌑 SolAgents API running on http://${HOST}:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health`);
  console.log(`   WS Feed: ws://${HOST}:${PORT}/ws/trades`);
  console.log(`   Info:   http://localhost:${PORT}/api/info\n`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
