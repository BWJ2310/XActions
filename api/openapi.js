/**
 * OpenAPI 3.1 Specification for XActions AI API
 *
 * Serves /openapi.json for x402scan automatic resource discovery.
 * Includes x402 payment extensions so scanners can display pricing,
 * network info, and facilitator details for each endpoint.
 *
 * @see https://x402.org
 * @author nichxbt
 */

import {
  PAY_TO_ADDRESS,
  FACILITATOR_URL,
  NETWORK,
  AI_OPERATION_PRICES,
  SUPPORTED_NETWORKS,
  getAcceptedNetworks,
  isX402Configured,
} from './config/x402-config.js';

/**
 * Build the x-payment-info extension for an operation.
 * Conforms to x402scan discovery spec.
 */
function paymentInfo(operation) {
  const price = AI_OPERATION_PRICES[operation];
  if (!price) return undefined;
  return {
    protocols: ['x402'],
    pricingMode: 'fixed',
    price: price.replace('$', ''),
  };
}

/**
 * Helper — standard error schema ref
 */
const errorRef = { $ref: '#/components/schemas/Error' };

/**
 * Helper — 402 response
 */
const payment402 = {
  description: 'Payment Required — sign a USDC payment and retry with X-PAYMENT header',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/PaymentRequired' } } },
};

/**
 * Helper — session body property
 */
const sessionProp = {
  sessionCookie: {
    type: 'string',
    description: 'X/Twitter auth_token cookie value',
  },
};

/**
 * Generate the full OpenAPI spec object.
 */
export function generateSpec() {
  const configured = isX402Configured();
  const networks = getAcceptedNetworks(true);

  return {
    openapi: '3.1.0',
    info: {
      title: 'XActions AI API',
      version: '1.0.0',
      description:
        'X/Twitter automation API for AI agents. Pay-per-request via x402 protocol (USDC on Base). ' +
        'Scrape profiles, automate actions, monitor followers, download media, and generate content.',
      'x-guidance': `XActions is a pay-per-request X/Twitter automation API designed for AI agents.

How to use this API:
1. All paid endpoints are under /api/ai/ and accept POST requests with JSON bodies.
2. Most endpoints require a sessionCookie field — set the user's X/Twitter auth_token cookie value in the request body or X-Session-Cookie header.
3. Payment is handled via the x402 protocol: send a request without payment to receive a 402 response with payment requirements, sign a USDC payment, then retry with the X-PAYMENT header.
4. Payments settle in USDC on Base (chain ID 8453). Base Sepolia (84532) is supported for testing.
5. Free info endpoints: GET /api/ai/ (docs), GET /api/ai/health (status), GET /api/ai/pricing (rates).

Categories:
- scrape: Extract data from X/Twitter (profiles, followers, tweets, hashtags, media)
- action: Automate account actions (unfollow, like, follow, detect unfollowers)
- monitor: Track account changes, follower diffs, snapshots over time
- download/export/unroll: Utility operations (videos, bookmarks, threads)
- writer: AI-powered content generation (voice analysis, tweet generation, calendars)

Free alternatives: Browser scripts, CLI, and Node.js library at https://xactions.app are 100% free. This paid API is for remote AI agent access only.`,
      contact: {
        name: 'nichxbt',
        url: 'https://github.com/nirholas/XActions',
      },
      license: {
        name: 'MIT',
        url: 'https://github.com/nirholas/XActions/blob/main/LICENSE',
      },
      'x-logo': {
        url: 'https://xactions.app/icons/icon-512.png',
      },
    },

    servers: [
      { url: 'https://xactions.app', description: 'Production' },
    ],

    // ── x402 top-level extension ──────────────────────────────────
    'x-x402': {
      enabled: configured,
      version: 2,
      facilitator: FACILITATOR_URL,
      payTo: PAY_TO_ADDRESS,
      networks: networks.map((n) => ({
        network: n.network,
        name: n.name,
        usdc: n.usdc,
        recommended: n.recommended || false,
        testnet: n.testnet || false,
      })),
      defaultNetwork: NETWORK,
    },

    // ── Security ──────────────────────────────────────────────────
    components: {
      securitySchemes: {
        x402Payment: {
          type: 'apiKey',
          in: 'header',
          name: 'X-PAYMENT',
          description: 'Signed USDC payment payload per x402 protocol',
        },
        sessionCookie: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Session-Cookie',
          description: 'X/Twitter auth_token cookie for browser automation',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: { type: 'string' },
            message: { type: 'string' },
            retryable: { type: 'boolean' },
            retryAfterMs: { type: 'integer' },
            timestamp: { type: 'string', format: 'date-time' },
          },
        },
        PaymentRequired: {
          type: 'object',
          properties: {
            x402Version: { type: 'integer', example: 2 },
            accepts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  scheme: { type: 'string', example: 'exact' },
                  network: { type: 'string', example: 'eip155:8453' },
                  maxAmountRequired: { type: 'string', example: '$0.001' },
                  resource: { type: 'string' },
                  payTo: { type: 'string' },
                },
              },
            },
          },
        },
        SuccessResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: { type: 'object' },
            meta: {
              type: 'object',
              properties: {
                scrapedAt: { type: 'string', format: 'date-time' },
                source: { type: 'string', example: 'x.com' },
              },
            },
          },
        },
        AsyncOperationResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            operationId: { type: 'string' },
            status: { type: 'string', example: 'queued' },
            statusUrl: { type: 'string' },
          },
        },
      },
    },

    security: [{ x402Payment: [] }],

    // ── Paths ──────────────────────────────────────────────────────
    paths: {
      // ─── Free endpoints ──────────────────────────────────────────
      '/api/ai/': {
        get: {
          tags: ['Info'],
          summary: 'API documentation',
          description: 'Returns available endpoints, pricing, and usage info.',
          security: [],
          responses: { 200: { description: 'API documentation object' } },
        },
      },
      '/api/ai/health': {
        get: {
          tags: ['Info'],
          summary: 'Health check and x402 configuration',
          security: [],
          responses: { 200: { description: 'Health status and payment config' } },
        },
      },
      '/api/ai/pricing': {
        get: {
          tags: ['Info'],
          summary: 'Pricing for all operations',
          security: [],
          responses: { 200: { description: 'Pricing table' } },
        },
      },

      // ─── Scraping ────────────────────────────────────────────────
      '/api/ai/scrape/profile': {
        post: {
          tags: ['Scraping'],
          summary: 'Get profile information',
          'x-payment-info': paymentInfo('scrape:profile'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['username'],
                  properties: {
                    ...sessionProp,
                    username: { type: 'string', example: 'elonmusk' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Profile data', content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } } } },
            402: payment402,
            400: { description: 'Missing parameters', content: { 'application/json': { schema: errorRef } } },
          },
        },
      },
      '/api/ai/scrape/followers': {
        post: {
          tags: ['Scraping'],
          summary: 'List followers (up to 1 000)',
          'x-payment-info': paymentInfo('scrape:followers'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['username'],
                  properties: {
                    ...sessionProp,
                    username: { type: 'string', example: 'elonmusk' },
                    limit: { type: 'integer', default: 100, maximum: 1000 },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Follower list' }, 402: payment402 },
        },
      },
      '/api/ai/scrape/following': {
        post: {
          tags: ['Scraping'],
          summary: 'List following (up to 1 000)',
          'x-payment-info': paymentInfo('scrape:following'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['username'],
                  properties: {
                    ...sessionProp,
                    username: { type: 'string', example: 'elonmusk' },
                    limit: { type: 'integer', default: 100, maximum: 1000 },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Following list' }, 402: payment402 },
        },
      },
      '/api/ai/scrape/tweets': {
        post: {
          tags: ['Scraping'],
          summary: 'Get tweet history',
          'x-payment-info': paymentInfo('scrape:tweets'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['username'],
                  properties: {
                    ...sessionProp,
                    username: { type: 'string', example: 'elonmusk' },
                    limit: { type: 'integer', default: 50, maximum: 200 },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Tweet list' }, 402: payment402 },
        },
      },
      '/api/ai/scrape/thread': {
        post: {
          tags: ['Scraping'],
          summary: 'Get thread / conversation',
          'x-payment-info': paymentInfo('scrape:thread'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['tweetId'],
                  properties: {
                    ...sessionProp,
                    tweetId: { type: 'string', example: '1234567890' },
                    tweetUrl: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Thread data' }, 402: payment402 },
        },
      },
      '/api/ai/scrape/search': {
        post: {
          tags: ['Scraping'],
          summary: 'Search tweets',
          'x-payment-info': paymentInfo('scrape:search'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['query'],
                  properties: {
                    ...sessionProp,
                    query: { type: 'string', example: 'bitcoin' },
                    limit: { type: 'integer', default: 50 },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Search results' }, 402: payment402 },
        },
      },
      '/api/ai/scrape/hashtag': {
        post: {
          tags: ['Scraping'],
          summary: 'Get tweets for a hashtag',
          'x-payment-info': paymentInfo('scrape:hashtag'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['hashtag'],
                  properties: {
                    ...sessionProp,
                    hashtag: { type: 'string', example: 'AI' },
                    limit: { type: 'integer', default: 50 },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Hashtag tweets' }, 402: payment402 },
        },
      },
      '/api/ai/scrape/media': {
        post: {
          tags: ['Scraping'],
          summary: 'Get media from a profile',
          'x-payment-info': paymentInfo('scrape:media'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['username'],
                  properties: {
                    ...sessionProp,
                    username: { type: 'string', example: 'elonmusk' },
                    limit: { type: 'integer', default: 50 },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Media list' }, 402: payment402 },
        },
      },

      // ─── Actions ─────────────────────────────────────────────────
      '/api/ai/action/unfollow-non-followers': {
        post: {
          tags: ['Actions'],
          summary: 'Unfollow accounts that don\'t follow back',
          'x-payment-info': paymentInfo('action:unfollow-non-followers'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ...sessionProp,
                    maxUnfollows: { type: 'integer', default: 100, maximum: 500 },
                    dryRun: { type: 'boolean', default: false },
                    excludeUsernames: { type: 'array', items: { type: 'string' } },
                    excludeVerified: { type: 'boolean', default: false },
                    delayMs: { type: 'integer', default: 2000, minimum: 1000 },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Operation queued', content: { 'application/json': { schema: { $ref: '#/components/schemas/AsyncOperationResponse' } } } },
            402: payment402,
          },
        },
      },
      '/api/ai/action/unfollow-everyone': {
        post: {
          tags: ['Actions'],
          summary: 'Unfollow all accounts',
          'x-payment-info': paymentInfo('action:unfollow-everyone'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ...sessionProp,
                    dryRun: { type: 'boolean', default: false },
                    delayMs: { type: 'integer', default: 2000, minimum: 1000 },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Operation queued' }, 402: payment402 },
        },
      },
      '/api/ai/action/detect-unfollowers': {
        post: {
          tags: ['Actions'],
          summary: 'Detect who unfollowed you',
          'x-payment-info': paymentInfo('action:detect-unfollowers'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ...sessionProp,
                    username: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Unfollower list' }, 402: payment402 },
        },
      },
      '/api/ai/action/auto-like': {
        post: {
          tags: ['Actions'],
          summary: 'Auto-like tweets by keyword',
          'x-payment-info': paymentInfo('action:auto-like'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['keywords'],
                  properties: {
                    ...sessionProp,
                    keywords: { type: 'array', items: { type: 'string' } },
                    limit: { type: 'integer', default: 50 },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Operation queued' }, 402: payment402 },
        },
      },
      '/api/ai/action/follow-engagers': {
        post: {
          tags: ['Actions'],
          summary: 'Follow users who engaged with a tweet',
          'x-payment-info': paymentInfo('action:follow-engagers'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['tweetId'],
                  properties: {
                    ...sessionProp,
                    tweetId: { type: 'string' },
                    limit: { type: 'integer', default: 50 },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Operation queued' }, 402: payment402 },
        },
      },
      '/api/ai/action/keyword-follow': {
        post: {
          tags: ['Actions'],
          summary: 'Follow users tweeting about a keyword',
          'x-payment-info': paymentInfo('action:keyword-follow'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['keyword'],
                  properties: {
                    ...sessionProp,
                    keyword: { type: 'string' },
                    limit: { type: 'integer', default: 50 },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Operation queued' }, 402: payment402 },
        },
      },
      '/api/ai/action/status/{operationId}': {
        get: {
          tags: ['Actions'],
          summary: 'Check operation status',
          security: [],
          parameters: [
            { name: 'operationId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'Operation status' } },
        },
      },

      // ─── Monitoring ──────────────────────────────────────────────
      '/api/ai/monitor/account': {
        post: {
          tags: ['Monitoring'],
          summary: 'Monitor account changes',
          'x-payment-info': paymentInfo('monitor:account'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['username'],
                  properties: {
                    ...sessionProp,
                    username: { type: 'string' },
                    includeFollowers: { type: 'boolean', default: true },
                    includeFollowing: { type: 'boolean', default: true },
                    includeStats: { type: 'boolean', default: true },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Snapshot queued' }, 402: payment402 },
        },
      },
      '/api/ai/monitor/followers': {
        post: {
          tags: ['Monitoring'],
          summary: 'Monitor follower changes',
          'x-payment-info': paymentInfo('monitor:followers'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['username'],
                  properties: { ...sessionProp, username: { type: 'string' } },
                },
              },
            },
          },
          responses: { 200: { description: 'Follower diff' }, 402: payment402 },
        },
      },
      '/api/ai/alert/new-followers': {
        post: {
          tags: ['Monitoring'],
          summary: 'Get new follower alerts',
          'x-payment-info': paymentInfo('alert:new-followers'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['username'],
                  properties: { ...sessionProp, username: { type: 'string' } },
                },
              },
            },
          },
          responses: { 200: { description: 'New followers' }, 402: payment402 },
        },
      },
      '/api/ai/monitor/snapshot/{username}': {
        get: {
          tags: ['Monitoring'],
          summary: 'Get latest snapshot for a username',
          security: [],
          parameters: [
            { name: 'username', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'Latest snapshot data' } },
        },
      },

      // ─── Utility ─────────────────────────────────────────────────
      '/api/ai/download/video': {
        post: {
          tags: ['Utility'],
          summary: 'Download video from a tweet',
          'x-payment-info': paymentInfo('download:video'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ...sessionProp,
                    tweetUrl: { type: 'string', example: 'https://x.com/elonmusk/status/1234567890' },
                    tweetId: { type: 'string' },
                    quality: { type: 'string', enum: ['highest', 'lowest', 'all'], default: 'highest' },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Video URLs' }, 402: payment402 },
        },
      },
      '/api/ai/export/bookmarks': {
        post: {
          tags: ['Utility'],
          summary: 'Export bookmarks',
          'x-payment-info': paymentInfo('export:bookmarks'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ...sessionProp,
                    format: { type: 'string', enum: ['json', 'csv'], default: 'json' },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Bookmarks data' }, 402: payment402 },
        },
      },
      '/api/ai/unroll/thread': {
        post: {
          tags: ['Utility'],
          summary: 'Unroll thread to plain text',
          'x-payment-info': paymentInfo('unroll:thread'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ...sessionProp,
                    tweetUrl: { type: 'string' },
                    tweetId: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Unrolled thread' }, 402: payment402 },
        },
      },

      // ─── Writer ──────────────────────────────────────────────────
      '/api/ai/writer/analyze-voice': {
        post: {
          tags: ['Writer'],
          summary: 'Analyze a user\'s writing voice from tweets',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['username', 'authToken'],
                  properties: {
                    username: { type: 'string' },
                    authToken: { type: 'string', description: 'X/Twitter auth_token cookie' },
                    tweetLimit: { type: 'integer', default: 200 },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Voice profile analysis' }, 402: payment402 },
        },
      },
      '/api/ai/writer/generate': {
        post: {
          tags: ['Writer'],
          summary: 'Generate tweets in a user\'s voice',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['username', 'topic'],
                  properties: {
                    username: { type: 'string' },
                    topic: { type: 'string' },
                    count: { type: 'integer', default: 5 },
                    style: { type: 'string', enum: ['casual', 'professional', 'provocative', 'educational'] },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Generated tweets' }, 402: payment402 },
        },
      },
      '/api/ai/writer/rewrite': {
        post: {
          tags: ['Writer'],
          summary: 'Rewrite / improve an existing tweet',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['tweet'],
                  properties: {
                    tweet: { type: 'string' },
                    goal: { type: 'string', enum: ['engagement', 'clarity', 'humor', 'professionalism'] },
                    voiceUsername: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Rewritten tweet' }, 402: payment402 },
        },
      },
      '/api/ai/writer/calendar': {
        post: {
          tags: ['Writer'],
          summary: 'Generate weekly content calendar',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['username'],
                  properties: {
                    username: { type: 'string' },
                    niche: { type: 'string' },
                    tweetsPerDay: { type: 'integer', default: 3 },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Content calendar' }, 402: payment402 },
        },
      },
      '/api/ai/writer/reply': {
        post: {
          tags: ['Writer'],
          summary: 'Generate a reply to a tweet',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['tweetText'],
                  properties: {
                    tweetText: { type: 'string' },
                    tweetUrl: { type: 'string' },
                    voiceUsername: { type: 'string' },
                    tone: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Generated reply' }, 402: payment402 },
        },
      },
      '/api/ai/writer/voice-profiles': {
        get: {
          tags: ['Writer'],
          summary: 'List saved voice profiles',
          security: [],
          responses: { 200: { description: 'Array of voice profiles' } },
        },
      },
      '/api/ai/writer/voice-profiles/{username}': {
        get: {
          tags: ['Writer'],
          summary: 'Get a specific voice profile',
          security: [],
          parameters: [
            { name: 'username', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'Voice profile' }, 404: { description: 'Not found' } },
        },
      },
    },

    tags: [
      { name: 'Info', description: 'Free informational endpoints' },
      { name: 'Scraping', description: 'Structured data extraction from X/Twitter' },
      { name: 'Actions', description: 'Account automation (unfollow, like, follow)' },
      { name: 'Monitoring', description: 'Track account & follower changes over time' },
      { name: 'Utility', description: 'Video download, bookmark export, thread unroll' },
      { name: 'Writer', description: 'AI-powered tweet generation & voice analysis' },
    ],
  };
}

/**
 * Generate /.well-known/x402 response.
 * Lists all payable resources as "METHOD /path" entries per x402scan spec.
 */
export function generateWellKnown() {
  const resources = [];

  for (const operation of Object.keys(AI_OPERATION_PRICES)) {
    const [category, action] = operation.split(':');
    resources.push(`POST /api/ai/${category}/${action}`);
  }

  return {
    version: 1,
    resources,
  };
}
