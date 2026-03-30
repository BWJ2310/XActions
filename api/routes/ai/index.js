// Copyright (c) 2024-2026 nich (@nichxbt). Business Source License 1.1.
/**
 * AI Agent API Routes
 *
 * Dedicated endpoints optimized for AI agent consumption.
 * All routes are protected by x402 payment middleware.
 *
 * Humans should use:
 * - Browser scripts at https://xactions.app/features
 * - Dashboard at https://xactions.app/dashboard
 *
 * @see https://xactions.app/docs/ai-api
 */

import express from 'express';
import scrapeRoutes from './scrape.js';
import actionRoutes from './actions.js';
import monitorRoutes from './monitor.js';
import utilityRoutes from './utility.js';
import writerRoutes from './writer.js';
import postingRoutes from './posting.js';
import engagementRoutes from './engagement.js';
import messagesRoutes from './messages.js';
import profileRoutes from './profile.js';
import grokRoutes from './grok.js';
import listsRoutes from './lists.js';
import spacesRoutes from './spaces.js';
import analyticsRoutes from './analytics.js';
import sentimentRoutes from './sentiment.js';
import streamsRoutes from './streams.js';
import workflowsRoutes from './workflows.js';
import portabilityRoutes from './portability.js';
import personasRoutes from './personas.js';
import graphRoutes from './graph.js';
import crmRoutes from './crm.js';
import schedulerRoutes from './scheduler.js';
import optimizerRoutes from './optimizer.js';
import notificationsRoutes from './notifications.js';
import datasetsRoutes from './datasets.js';
import teamsRoutes from './teams.js';

const router = express.Router();

// API documentation endpoint (free - no payment required)
router.get('/', (req, res) => {
  res.json({
    service: 'XActions AI API',
    version: '2.0.0',
    description: 'X/Twitter automation API for AI agents. Pay-per-request via x402.',
    authentication: 'X-PAYMENT header with signed USDC payment',
    documentation: 'https://xactions.app/docs/ai-api',

    endpoints: {
      scraping: {
        'POST /api/ai/scrape/profile': 'Get profile information',
        'POST /api/ai/scrape/followers': 'List followers',
        'POST /api/ai/scrape/following': 'List following',
        'POST /api/ai/scrape/tweets': 'Get tweet history',
        'POST /api/ai/scrape/thread': 'Get thread/conversation',
        'POST /api/ai/scrape/search': 'Search tweets',
        'POST /api/ai/scrape/hashtag': 'Get hashtag tweets',
        'POST /api/ai/scrape/media': 'Get media from profile',
        'POST /api/ai/scrape/likes': 'Get tweet likers',
        'POST /api/ai/scrape/retweets': 'Get tweet retweeters',
        'POST /api/ai/scrape/replies': 'Get tweet replies',
        'POST /api/ai/scrape/quote-tweets': 'Get quote tweets',
        'POST /api/ai/scrape/user-likes': 'Get tweets a user liked',
        'POST /api/ai/scrape/mentions': 'Get @mentions of a user',
        'POST /api/ai/scrape/recommendations': 'Get recommended accounts',
      },
      posting: {
        'POST /api/ai/posting/tweet': 'Post a tweet',
        'POST /api/ai/posting/thread': 'Post a thread',
        'POST /api/ai/posting/poll': 'Create a poll',
        'POST /api/ai/posting/schedule': 'Schedule a tweet',
        'POST /api/ai/posting/delete': 'Delete a tweet',
        'POST /api/ai/posting/reply': 'Reply to a tweet',
        'POST /api/ai/posting/bookmark': 'Bookmark a tweet',
        'POST /api/ai/posting/bookmarks': 'Get bookmarks',
        'POST /api/ai/posting/clear-bookmarks': 'Clear bookmarks',
        'POST /api/ai/posting/article': 'Publish an article',
      },
      engagement: {
        'POST /api/ai/engagement/follow': 'Follow a user',
        'POST /api/ai/engagement/unfollow': 'Unfollow a user',
        'POST /api/ai/engagement/like': 'Like a tweet',
        'POST /api/ai/engagement/retweet': 'Retweet a tweet',
        'POST /api/ai/engagement/quote-tweet': 'Quote-tweet',
        'POST /api/ai/engagement/auto-follow': 'Auto-follow by keyword/hashtag',
        'POST /api/ai/engagement/smart-unfollow': 'Intelligently unfollow',
        'POST /api/ai/engagement/auto-retweet': 'Auto-retweet',
        'POST /api/ai/engagement/bulk-execute': 'Bulk execute actions',
        'POST /api/ai/engagement/notifications': 'Get notifications',
        'POST /api/ai/engagement/mute': 'Mute a user',
        'POST /api/ai/engagement/unmute': 'Unmute a user',
        'POST /api/ai/engagement/trends': 'Get trending topics',
        'POST /api/ai/engagement/explore': 'Get explore feed',
        'POST /api/ai/engagement/detect-bots': 'Detect bot accounts',
        'POST /api/ai/engagement/find-influencers': 'Find niche influencers',
        'POST /api/ai/engagement/smart-target': 'Smart targeting',
        'POST /api/ai/engagement/crypto-analyze': 'Crypto sentiment analysis',
        'POST /api/ai/engagement/audience-insights': 'Audience demographics',
        'POST /api/ai/engagement/engagement-report': 'Engagement report',
      },
      actions: {
        'POST /api/ai/action/unfollow-non-followers': 'Unfollow non-followers',
        'POST /api/ai/action/unfollow-everyone': 'Unfollow all',
        'POST /api/ai/action/detect-unfollowers': 'Detect unfollowers',
        'POST /api/ai/action/auto-like': 'Auto-like tweets',
        'POST /api/ai/action/follow-engagers': 'Follow from engagement',
        'POST /api/ai/action/keyword-follow': 'Follow by keyword',
        'POST /api/ai/action/follow': 'Follow a user',
        'POST /api/ai/action/unfollow': 'Unfollow a user',
        'POST /api/ai/action/like': 'Like a tweet',
        'POST /api/ai/action/retweet': 'Retweet a tweet',
        'POST /api/ai/action/quote-tweet': 'Quote-tweet',
        'POST /api/ai/action/post-tweet': 'Post a tweet',
        'POST /api/ai/action/auto-follow': 'Auto-follow',
        'POST /api/ai/action/smart-unfollow': 'Smart unfollow',
        'POST /api/ai/action/auto-retweet': 'Auto-retweet',
        'POST /api/ai/action/bulk-execute': 'Bulk execute',
        'GET /api/ai/action/status/:operationId': 'Check operation status',
        'GET /api/ai/action/history': 'Operation history',
      },
      analytics: {
        'POST /api/ai/analytics/account': 'Account analytics',
        'POST /api/ai/analytics/post': 'Post performance',
        'POST /api/ai/analytics/creator': 'Creator analytics',
        'POST /api/ai/analytics/brand-monitor': 'Brand monitoring',
        'POST /api/ai/analytics/competitor': 'Competitor analysis',
        'POST /api/ai/analytics/audience-overlap': 'Audience overlap',
        'POST /api/ai/analytics/history': 'Analytics history',
        'POST /api/ai/analytics/snapshot': 'Take snapshot',
        'POST /api/ai/analytics/growth-rate': 'Growth rate',
        'POST /api/ai/analytics/compare-accounts': 'Compare accounts',
        'POST /api/ai/analytics/analyze-voice': 'Analyze writing voice',
        'POST /api/ai/analytics/generate-tweet': 'Generate tweet in voice',
        'POST /api/ai/analytics/rewrite-tweet': 'Rewrite tweet',
        'POST /api/ai/analytics/summarize-thread': 'Summarize thread',
        'POST /api/ai/analytics/best-time': 'Best time to post',
      },
      messages: {
        'POST /api/ai/messages/send': 'Send DM',
        'POST /api/ai/messages/conversations': 'List conversations',
        'POST /api/ai/messages/export': 'Export DMs',
      },
      profile: {
        'POST /api/ai/profile/update': 'Update profile',
        'POST /api/ai/profile/check-premium': 'Check premium status',
        'POST /api/ai/profile/settings': 'Get settings',
        'POST /api/ai/profile/toggle-protected': 'Toggle protected tweets',
        'POST /api/ai/profile/blocked': 'Get blocked accounts',
      },
      grok: {
        'POST /api/ai/grok/query': 'Query Grok',
        'POST /api/ai/grok/summarize': 'Summarize with Grok',
        'POST /api/ai/grok/analyze-image': 'Analyze image with Grok',
      },
      lists: {
        'POST /api/ai/lists/all': 'Get all lists',
        'POST /api/ai/lists/members': 'Get list members',
      },
      spaces: {
        'POST /api/ai/spaces/list': 'Discover Spaces',
        'POST /api/ai/spaces/scrape': 'Scrape Space metadata',
        'POST /api/ai/spaces/join': 'Join a Space',
        'POST /api/ai/spaces/leave': 'Leave a Space',
        'POST /api/ai/spaces/status': 'Get Space status',
        'POST /api/ai/spaces/transcript': 'Get Space transcript',
      },
      monitoring: {
        'POST /api/ai/monitor/account': 'Monitor account',
        'POST /api/ai/monitor/followers': 'Monitor followers',
        'POST /api/ai/monitor/following': 'Monitor following',
        'POST /api/ai/monitor/keyword': 'Monitor keyword',
        'POST /api/ai/monitor/follower-alerts': 'Follower alerts',
        'POST /api/ai/monitor/track-engagement': 'Track tweet engagement',
        'GET /api/ai/monitor/snapshot/:username': 'Get snapshot',
      },
      sentiment: {
        'POST /api/ai/sentiment/analyze': 'Analyze sentiment',
        'POST /api/ai/sentiment/monitor': 'Monitor reputation',
        'POST /api/ai/sentiment/report': 'Reputation report',
      },
      streams: {
        'POST /api/ai/streams/start': 'Start stream',
        'POST /api/ai/streams/stop': 'Stop stream',
        'POST /api/ai/streams/list': 'List streams',
        'POST /api/ai/streams/pause': 'Pause stream',
        'POST /api/ai/streams/resume': 'Resume stream',
        'POST /api/ai/streams/status': 'Stream status',
        'POST /api/ai/streams/history': 'Stream history',
      },
      workflows: {
        'POST /api/ai/workflows/create': 'Create workflow',
        'POST /api/ai/workflows/run': 'Run workflow',
        'POST /api/ai/workflows/list': 'List workflows',
        'POST /api/ai/workflows/actions': 'Available actions',
      },
      personas: {
        'POST /api/ai/personas/create': 'Create persona',
        'POST /api/ai/personas/list': 'List personas',
        'POST /api/ai/personas/status': 'Persona status',
        'POST /api/ai/personas/edit': 'Edit persona',
        'POST /api/ai/personas/delete': 'Delete persona',
        'POST /api/ai/personas/run': 'Run persona',
        'POST /api/ai/personas/presets': 'Persona presets',
      },
      graph: {
        'POST /api/ai/graph/build': 'Build social graph',
        'POST /api/ai/graph/analyze': 'Analyze graph',
        'POST /api/ai/graph/recommendations': 'Graph recommendations',
        'POST /api/ai/graph/list': 'List graphs',
      },
      portability: {
        'POST /api/ai/portability/export-account': 'Export account',
        'POST /api/ai/portability/migrate': 'Migrate to platform',
        'POST /api/ai/portability/diff': 'Diff exports',
        'POST /api/ai/portability/platforms': 'Supported platforms',
        'POST /api/ai/portability/import': 'Import data',
        'POST /api/ai/portability/convert': 'Convert format',
      },
      crm: {
        'POST /api/ai/crm/sync': 'Sync to CRM',
        'POST /api/ai/crm/tag': 'Tag contact',
        'POST /api/ai/crm/search': 'Search CRM',
        'POST /api/ai/crm/segment': 'CRM segment',
      },
      schedule: {
        'POST /api/ai/schedule/add': 'Schedule post',
        'POST /api/ai/schedule/list': 'List scheduled',
        'POST /api/ai/schedule/remove': 'Remove scheduled',
        'POST /api/ai/schedule/rss-add': 'Add RSS feed',
        'POST /api/ai/schedule/rss-check': 'Check RSS',
        'POST /api/ai/schedule/rss-drafts': 'RSS drafts',
        'POST /api/ai/schedule/evergreen': 'Find evergreen content',
      },
      optimizer: {
        'POST /api/ai/optimizer/optimize': 'Optimize tweet',
        'POST /api/ai/optimizer/hashtags': 'Suggest hashtags',
        'POST /api/ai/optimizer/predict': 'Predict performance',
        'POST /api/ai/optimizer/variations': 'Generate variations',
      },
      writer: {
        'POST /api/ai/writer/analyze-voice': 'Analyze writing voice',
        'POST /api/ai/writer/generate': 'Generate tweets in voice',
        'POST /api/ai/writer/rewrite': 'Rewrite tweet',
        'POST /api/ai/writer/calendar': 'Content calendar',
        'POST /api/ai/writer/reply': 'Generate reply',
      },
      utility: {
        'POST /api/ai/download/video': 'Download video',
        'POST /api/ai/export/bookmarks': 'Export bookmarks',
        'POST /api/ai/unroll/thread': 'Unroll thread',
        'POST /api/ai/analyze/profile': 'Analyze profile',
      },
      notifications: {
        'POST /api/ai/notify/send': 'Send webhook notification',
        'POST /api/ai/notify/test': 'Test webhook',
      },
      datasets: {
        'POST /api/ai/datasets/list': 'List datasets',
        'POST /api/ai/datasets/get': 'Fetch dataset',
      },
      teams: {
        'POST /api/ai/teams/create': 'Create team',
        'POST /api/ai/teams/members': 'Get team members',
      },
    },

    x402: {
      protocol: 'https://x402.org',
      networks: ['Base (USDC)', 'Arbitrum', 'Ethereum', 'Base Sepolia (testnet)'],
      paymentHeader: 'X-PAYMENT',
    },

    rateLimit: {
      requestsPerMinute: 60,
      concurrentOperations: 5,
      burstAllowance: 10,
    },

    freeAlternatives: {
      browser: 'https://xactions.app/features - Free browser scripts',
      cli: 'npm install -g xactions - Free CLI tool',
      library: 'npm install xactions - Free Node.js library',
    },

    support: {
      docs: 'https://xactions.app/docs',
      github: 'https://github.com/nirholas/XActions',
      twitter: '@nichxbt',
    },
  });
});

// Health check (free)
router.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString(), version: '2.0.0' });
});

// Mount original route modules
router.use('/scrape', scrapeRoutes);
router.use('/action', actionRoutes);
router.use('/monitor', monitorRoutes);
router.use('/alert', monitorRoutes);      // backward compat: /alert/new-followers
// Mount utility router once across all its category prefixes.
// Mounting the same router instance multiple times caused Express to walk
// the same handler chain four times per request.
router.use(['/download', '/export', '/unroll', '/analyze'], utilityRoutes);
router.use('/writer', writerRoutes);

// Mount new route modules
router.use('/posting', postingRoutes);
router.use('/engagement', engagementRoutes);
router.use('/messages', messagesRoutes);
router.use('/profile', profileRoutes);
router.use('/grok', grokRoutes);
router.use('/lists', listsRoutes);
router.use('/spaces', spacesRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/sentiment', sentimentRoutes);
router.use('/streams', streamsRoutes);
router.use('/workflows', workflowsRoutes);
router.use('/portability', portabilityRoutes);
router.use('/personas', personasRoutes);
router.use('/graph', graphRoutes);
router.use('/crm', crmRoutes);
router.use('/schedule', schedulerRoutes);
router.use('/optimizer', optimizerRoutes);
router.use('/notify', notificationsRoutes);
router.use('/datasets', datasetsRoutes);
router.use('/teams', teamsRoutes);

// Catch-all for undefined routes
router.all('*', (req, res) => {
  res.status(404).json({
    error: 'ENDPOINT_NOT_FOUND',
    message: `Endpoint ${req.method} ${req.path} not found`,
    availableEndpoints: 'GET /api/ai/ for full documentation',
    docs: 'https://xactions.app/docs/ai-api',
  });
});

export default router;
