/**
 * x402 Payment Middleware for AI Agent Endpoints
 *
 * Uses the official @x402/express SDK for protocol-compliant payment handling.
 * XActions-specific hooks handle analytics, webhooks, and audit logging.
 *
 * Flow:
 * 1. AI agent calls /api/ai/* endpoint
 * 2. No payment header → 402 Payment Required with requirements
 * 3. Agent signs USDC payment, retries with X-PAYMENT header
 * 4. SDK verifies via facilitator, executes if valid
 * 5. Settlement occurs, response includes payment headers
 *
 * @see https://x402.org
 * @author nichxbt
 */

import {
  PAY_TO_ADDRESS,
  FACILITATOR_URL,
  NETWORK,
  AI_OPERATION_PRICES,
  getOperationName,
  SUPPORTED_NETWORKS,
  getAcceptedNetworks,
  ensureConfigValidated,
  isX402Configured
} from '../config/x402-config.js';
import { recordPayment } from '../services/payment-stats.js';
import {
  notifyPaymentSettled,
  notifyPaymentFailed,
  PAYMENT_EVENTS
} from '../services/payment-webhooks.js';

// Lazy-loaded x402 middleware instance
let _middleware = null;
let _initPromise = null;
let _initFailed = false;

/**
 * Build route configuration for the official x402 middleware.
 * Maps each AI operation to its price, network, and payTo address.
 */
function buildRouteConfig() {
  const routes = {};

  for (const [operation, price] of Object.entries(AI_OPERATION_PRICES)) {
    const [category, action] = operation.split(':');
    const routePath = `POST /api/ai/${category}/${action}`;

    routes[routePath] = {
      price,
      network: NETWORK,
      payTo: PAY_TO_ADDRESS,
    };
  }

  return routes;
}

/**
 * Initialize the official @x402/express middleware with hooks for
 * XActions analytics, webhooks, and audit logging.
 */
async function initializeMiddleware() {
  const { paymentMiddleware } = await import('@x402/express');
  const { x402ResourceServer, HTTPFacilitatorClient } = await import('@x402/core/server');
  const { ExactEvmScheme } = await import('@x402/evm/exact/server');

  // Create facilitator client
  const facilitator = new HTTPFacilitatorClient(FACILITATOR_URL);

  // Create resource server and register the EVM scheme for the configured network
  const server = new x402ResourceServer(facilitator);
  server.register(NETWORK, new ExactEvmScheme());

  // Also register testnet if we're in development and using mainnet
  if (process.env.NODE_ENV !== 'production' && NETWORK !== 'eip155:84532') {
    server.register('eip155:84532', new ExactEvmScheme());
  }
  // Also register mainnet if we're on testnet, so agents can choose
  if (NETWORK !== 'eip155:8453') {
    try {
      server.register('eip155:8453', new ExactEvmScheme());
    } catch {
      // Already registered or not needed
    }
  }

  // Hook: after successful settlement — record analytics and send webhooks
  server.onAfterSettle(async (context) => {
    const { paymentPayload, requirements, result } = context;
    const operation = extractOperation(requirements);
    const price = requirements?.maxAmountRequired || requirements?.price || 'unknown';
    const txHash = result?.transaction || result?.transactionHash || null;

    const auditLog = {
      timestamp: new Date().toISOString(),
      operation,
      price,
      network: requirements?.network || NETWORK,
      payTo: PAY_TO_ADDRESS,
      settled: true,
      txHash,
    };

    console.log(`💰 x402: Settled ${price} for ${operation}`);
    if (process.env.X402_DEBUG === 'true') {
      console.log(`   📝 Audit: ${JSON.stringify(auditLog)}`);
    }

    // Emit realtime event
    if (global.io) {
      global.io.emit('x402:payment', auditLog);
    }

    // Record for analytics
    recordPayment({
      operation,
      price,
      network: requirements?.network || NETWORK,
      paymentId: txHash,
      payerAddress: paymentPayload?.payload?.authorization?.from || 'unknown',
    });

    // Send webhook (non-blocking)
    notifyPaymentSettled({
      price,
      operation,
      payerAddress: paymentPayload?.payload?.authorization?.from || 'unknown',
      network: requirements?.network || NETWORK,
      transactionHash: txHash,
    }, txHash).catch(() => {});
  });

  // Hook: settlement failure — log and notify
  server.onSettleFailure(async (context) => {
    const { paymentPayload, requirements, error } = context;
    const operation = extractOperation(requirements);
    const price = requirements?.maxAmountRequired || requirements?.price || 'unknown';

    console.error(`🚨 x402: Settlement FAILED for ${operation}: ${error?.message || error}`);

    notifyPaymentFailed({
      price,
      operation,
      payerAddress: paymentPayload?.payload?.authorization?.from || 'unknown',
      network: requirements?.network || NETWORK,
    }, error?.message || 'Settlement failed').catch(() => {});
  });

  // Hook: verification failure — log for monitoring
  server.onVerifyFailure(async (context) => {
    const { paymentPayload, requirements, error } = context;
    const operation = extractOperation(requirements);

    console.warn(`⚠️  x402: Verification failed for ${operation}: ${error?.message || error}`);

    notifyPaymentFailed({
      price: requirements?.maxAmountRequired || 'unknown',
      operation,
      payerAddress: paymentPayload?.payload?.authorization?.from || 'unknown',
      network: requirements?.network || NETWORK,
    }, `Verification failed: ${error?.message || error}`).catch(() => {});
  });

  // Build routes and create the official middleware
  const routes = buildRouteConfig();

  console.log(`✅ x402 payment middleware ready`);
  console.log(`   💰 Pay to: ${PAY_TO_ADDRESS}`);
  console.log(`   🌐 Network: ${NETWORK === 'eip155:8453' ? 'Base Mainnet' : 'Base Sepolia Testnet'} (${NETWORK})`);
  console.log(`   🔗 Facilitator: ${FACILITATOR_URL}`);
  console.log(`   📋 Protected operations: ${Object.keys(routes).length}`);

  return paymentMiddleware(routes, server);
}

/**
 * Extract operation name from payment requirements
 */
function extractOperation(requirements) {
  if (!requirements?.resource) return 'unknown';
  const match = requirements.resource.match(/\/api\/ai\/([^/]+)\/([^/?]+)/);
  return match ? `${match[1]}:${match[2]}` : 'unknown';
}

/**
 * x402 Payment Middleware
 *
 * Lazy-initializes the official @x402/express middleware on first request.
 * Falls through gracefully if x402 is not configured (development mode).
 */
export async function x402Middleware(req, res, next) {
  // Only protect AI endpoints
  if (!req.path.startsWith('/api/ai/')) {
    return next();
  }

  // Health and pricing endpoints are always free
  if (req.path === '/api/ai/health' || req.path === '/api/ai/pricing') {
    return next();
  }

  // Check if x402 is configured
  if (!ensureConfigValidated()) {
    // x402 not configured — pass through in development
    if (process.env.NODE_ENV !== 'production') {
      return next();
    }
    return res.status(500).json({ error: 'Payment system not configured' });
  }

  // Lazy-initialize middleware
  if (!_middleware && !_initFailed) {
    if (!_initPromise) {
      _initPromise = initializeMiddleware()
        .then(mw => { _middleware = mw; })
        .catch(err => {
          _initFailed = true;
          console.error('❌ x402 initialization failed:', err.message);
          console.log('   Install packages: npm install @x402/core @x402/evm @x402/express');
        })
        .finally(() => { _initPromise = null; });
    }
    await _initPromise;
  }

  if (!_middleware) {
    // Graceful degradation in development
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`⚠️  x402 not available, allowing ${req.path} without payment`);
      return next();
    }
    return res.status(503).json({ error: 'Payment system unavailable' });
  }

  // Delegate to the official @x402/express middleware
  return _middleware(req, res, next);
}

/**
 * x402 Health Check
 * Returns payment configuration without requiring payment.
 */
export function x402HealthCheck(req, res) {
  const configured = isX402Configured();
  const includeTestnet = process.env.NODE_ENV !== 'production';
  const networks = getAcceptedNetworks(includeTestnet);
  const recommendedNetwork = networks.find(n => n.recommended) || networks[0];

  res.json({
    service: 'XActions AI API',
    status: configured ? 'operational' : 'degraded',
    timestamp: new Date().toISOString(),
    x402: {
      enabled: configured,
      available: !_initFailed && configured,
      version: 2,
      facilitator: FACILITATOR_URL,
      payTo: configured ? PAY_TO_ADDRESS : null,
      networks: {
        supported: networks.map(n => ({
          network: n.network,
          name: n.name,
          usdc: n.usdc,
          gasCost: n.gasCost,
          recommended: n.recommended || false,
          testnet: n.testnet || false
        })),
        recommended: recommendedNetwork?.network,
        recommendedName: recommendedNetwork?.name,
        defaultNetwork: NETWORK
      }
    },
    pricing: AI_OPERATION_PRICES,
    endpoints: Object.keys(AI_OPERATION_PRICES).map(op => {
      const [category, action] = op.split(':');
      return {
        operation: op,
        name: getOperationName(op),
        path: `/api/ai/${category}/${action}`,
        price: AI_OPERATION_PRICES[op],
      };
    }),
  });
}

/**
 * Pricing endpoint — returns pricing and network info.
 */
export function x402Pricing(req, res) {
  const includeTestnet = process.env.NODE_ENV !== 'production';
  const networks = getAcceptedNetworks(includeTestnet);
  const recommendedNetwork = networks.find(n => n.recommended) || networks[0];

  res.json({
    currency: 'USDC',
    networks: networks.map(n => ({
      network: n.network,
      name: n.name,
      usdc: n.usdc,
      gasCost: n.gasCost,
      recommended: n.recommended || false
    })),
    recommendedNetwork: recommendedNetwork?.network,
    pricing: AI_OPERATION_PRICES,
  });
}

export default x402Middleware;
