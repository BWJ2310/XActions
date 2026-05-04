#!/usr/bin/env node
// Copyright (c) 2024-2026 nich (@nichxbt). Business Source License 1.1.
/**
 * XActions Local Tools (Puppeteer-based)
 * Free mode — all scraping delegated to canonical scrapers (single source of truth).
 * Action tools (follow, like, post, etc.) implemented directly via Puppeteer.
 *
 * @author nich (@nichxbt) - https://github.com/nirholas
 * @see https://xactions.app
 * @license MIT
 */

import {
  createBrowser,
  createPage,
  scrapeProfile,
  scrapeFollowers,
  scrapeFollowing,
  scrapeTweets,
  searchTweets,
  scrapeThread,
  scrapeLikes,
  scrapeMedia,
  scrapeListMembers,
  scrapeBookmarks,
  scrapeNotifications,
  scrapeTrending,
  scrapeSpaces,
  scrape,
} from '../scrapers/index.js';

import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// ============================================================================
// Singleton Browser Management
// ============================================================================

let browser = null;
let page = null;
let authenticatedCookie = null;
let browserIdleTimer = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomDelay = (min = 1000, max = 3000) =>
  sleep(min + Math.random() * (max - min));
const withTimeout = async (promise, timeoutMs) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
        if (timer.unref) timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};
const DEFAULT_NAVIGATION_TIMEOUT_MS = 20_000;
const DEFAULT_NAVIGATION_RETRIES = 1;
const DEFAULT_TWEET_TARGET_TIMEOUT_MS = 12_000;
const TWEET_ARTICLE_SELECTOR = 'article[data-testid="tweet"]';
const COMPOSER_TEXTBOX_SELECTOR = [
  '[data-testid="tweetTextarea_0"][contenteditable="true"]',
  '[data-testid^="tweetTextarea_"][contenteditable="true"]',
  '[role="textbox"][contenteditable="true"]',
].join(', ');
const COMPOSER_MODAL_SCOPE_SELECTOR = '[role="dialog"], [role="group"]';
const COMPOSER_PAGE_SCOPE_SELECTOR = `${COMPOSER_MODAL_SCOPE_SELECTOR}, [data-testid="primaryColumn"]`;

function getNavigationTimeoutMs() {
  const raw = process.env.XACTIONS_NAVIGATION_TIMEOUT_MS;
  if (!raw) return DEFAULT_NAVIGATION_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_NAVIGATION_TIMEOUT_MS;
}

function isNavigationTimeoutError(error) {
  return /Navigation timeout/i.test(`${error?.message || ''}`);
}

async function gotoX(page, url, timeout = getNavigationTimeoutMs(), { retries = DEFAULT_NAVIGATION_RETRIES } = {}) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout,
      });
    } catch (error) {
      lastError = error;
      if (!isNavigationTimeoutError(error) || attempt === retries) {
        throw error;
      }

      console.error(`Navigation timeout loading ${url}; retrying (${attempt + 1}/${retries})`);
      try {
        if (!page.isClosed?.()) {
          await page.goto('about:blank', {
            waitUntil: 'domcontentloaded',
            timeout: Math.min(timeout, 5000),
          });
        }
      } catch {}

      await sleep(500);
    }
  }

  throw lastError;
}

function getBrowserIdleMs() {
  const raw = process.env.XACTIONS_BROWSER_IDLE_MS;
  if (!raw) return 15 * 60 * 1000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 15 * 60 * 1000;
}

function clearBrowserIdleTimer() {
  if (browserIdleTimer) {
    clearTimeout(browserIdleTimer);
    browserIdleTimer = null;
  }
}

function normalizeUsername(value = '') {
  return String(value || '').trim().replace(/^@/, '');
}

let httpScraperPromise = null;

async function getHttpScraper() {
  if (!httpScraperPromise) {
    httpScraperPromise = import('../scrapers/twitter/http/index.js').then(
      (mod) => mod.createHttpScraper({}),
    );
  }
  return httpScraperPromise;
}

function buildTweetUrl(tweet, fallbackUsername = '') {
  if (tweet?.url) return tweet.url;
  const username = tweet?.author?.username || fallbackUsername;
  if (!tweet?.id || !username) return null;
  return `https://x.com/${username}/status/${tweet.id}`;
}

function parseSessionCookieInput(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return {};

  if (!raw.includes('=')) {
    return { auth_token: raw };
  }

  const cookies = {};
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex <= 0) continue;
    const name = trimmed.slice(0, equalsIndex).trim();
    const cookieValue = trimmed.slice(equalsIndex + 1).trim();
    if (name && cookieValue) cookies[name] = cookieValue;
  }

  return cookies.auth_token ? cookies : { auth_token: raw };
}

async function setSessionCookies(pg, cookieInput) {
  const cookies = parseSessionCookieInput(cookieInput);
  const entries = Object.entries(cookies);
  if (!entries.length) return false;

  const cookieObjects = entries.map(([name, value]) => ({
    name,
    value,
    domain: '.x.com',
    path: '/',
    httpOnly: ['auth_token', 'kdt'].includes(name),
    secure: true,
  }));

  if (pg._adapter) {
    const { getAdapter } = await import('../adapters/index.js');
    const adapter = await getAdapter(pg._adapter);
    for (const cookie of cookieObjects) {
      await adapter.setCookie(pg, cookie);
    }
    return true;
  }

  await pg.setCookie(...cookieObjects);
  return true;
}

/**
 * Ensure a browser/page pair is available, creating if needed.
 * Uses createBrowser/createPage from the canonical scrapers module.
 */
async function ensureBrowser({ authenticate = true } = {}) {
  clearBrowserIdleTimer();
  const envCookie = process.env.XACTIONS_SESSION_COOKIE;

  if (!browser || !browser.isConnected()) {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
    browser = await createBrowser();
    page = await createPage(browser);
    authenticatedCookie = null;
  }

  if (!page || page.isClosed?.()) {
    page = await createPage(browser);
  }

  if (authenticate && envCookie && authenticatedCookie !== envCookie) {
    await setSessionCookies(page, envCookie);
    authenticatedCookie = envCookie;
  }

  return { browser, page };
}

/**
 * Close browser (called by server.js on SIGINT/SIGTERM)
 */
export async function closeBrowser() {
  clearBrowserIdleTimer();
  if (browser) {
    try {
      await browser.close();
    } catch {}
    browser = null;
    page = null;
    authenticatedCookie = null;
  }
}

export function scheduleBrowserIdleClose() {
  clearBrowserIdleTimer();
  const idleMs = getBrowserIdleMs();
  if (!browser || idleMs === 0) return;

  browserIdleTimer = setTimeout(async () => {
    try {
      await closeBrowser();
      console.error(`Closed idle XActions browser after ${idleMs}ms`);
    } catch (error) {
      console.error('Failed to close idle XActions browser:', error.message);
    }
  }, idleMs);

  if (browserIdleTimer.unref) browserIdleTimer.unref();
}

export async function getPage() {
  const { page: pg } = await ensureBrowser();
  return pg;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Wait for a selector and click it. Returns true if clicked.
 */
async function clickIfPresent(pg, selector, { timeout = 3000 } = {}) {
  try {
    await pg.waitForSelector(selector, { timeout });
    const el = await pg.$(selector);
    if (el) {
      await el.click();
      return true;
    }
  } catch {}
  return false;
}

/**
 * Find a menu item by text pattern and click it.
 */
async function clickMenuItemByText(pg, pattern, { timeout = 3000, selectors = [] } = {}) {
  const itemSelector = [...selectors, '[role="menuitem"]'].join(', ');
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const items = await pg.$$(itemSelector);
    for (const item of items) {
      const match = await item.evaluate((el, sourcePattern, prioritySelectors) => {
        const re = new RegExp(sourcePattern.source, sourcePattern.flags);
        const text = `${el.innerText || ''} ${el.textContent || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-testid') || ''}`;
        const disabled = Boolean(
          el.hasAttribute('disabled') ||
          el.getAttribute('aria-disabled') === 'true' ||
          el.closest('[aria-disabled="true"]'),
        );
        const visible = (() => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && el.getAttribute('aria-hidden') !== 'true';
        })();
        return visible && !disabled && (
          re.test(text) ||
          prioritySelectors.some((selector) => {
            try {
              return el.matches(selector);
            } catch {
              return false;
            }
          })
        );
      }, { source: pattern.source, flags: pattern.flags }, selectors);
      if (!match) continue;

      try {
        await item.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
      } catch {}
      try {
        await item.click();
      } catch {
        await item.evaluate((el) => el.click());
      }
      return true;
    }

    await sleep(100);
  }

  return false;
}

async function clickQuoteMenuItem(pg, { timeout = 3000 } = {}) {
  const itemSelector = [
    '[data-testid="Dropdown-Item-Quote"]',
    '[data-testid="Dropdown"] [role="menuitem"]',
    '[role="menu"] [role="menuitem"]',
    'a[role="menuitem"][href="/compose/post"]',
    'a[role="menuitem"][href*="/compose/post"]',
  ].join(', ');
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const items = await pg.$$(itemSelector);
    for (const item of items) {
      const details = await item.evaluate((el) => {
        const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const text = clean(`${el.innerText || ''} ${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`);
        const testid = el.getAttribute('data-testid') || '';
        const href = el.getAttribute('href') || '';
        const disabled = Boolean(
          el.hasAttribute('disabled') ||
          el.getAttribute('aria-disabled') === 'true' ||
          el.closest('[aria-disabled="true"]'),
        );
        const visible = rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          el.getAttribute('aria-hidden') !== 'true';
        let pathname = '';
        try {
          pathname = href ? new URL(href, window.location.origin).pathname : '';
        } catch {}

        const normalizedText = text.toLowerCase();
        const isQuoteHref = pathname === '/compose/post';
        const isQuoteText = normalizedText === 'quote';
        const isKnownQuoteTestId = testid === 'Dropdown-Item-Quote';
        const isRepostAction = /repost|retweet|undo/i.test(`${normalizedText} ${testid}`);

        return {
          text,
          testid,
          href,
          pathname,
          visible,
          disabled,
          isQuote: visible && !disabled && !isRepostAction && (isQuoteHref || isQuoteText || isKnownQuoteTestId),
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      });
      if (!details.isQuote) continue;

      logQuoteFlowStage('quote_menu_item_candidate', details);
      try {
        await item.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
      } catch {}
      try {
        await item.click();
      } catch {
        await item.evaluate((el) => el.click());
      }
      return details;
    }

    await sleep(100);
  }

  return null;
}

async function findComposerScope(pg, { timeout = 8000, replyOnly = false, dialogOnly = false } = {}) {
  const scopeSelector = dialogOnly ? COMPOSER_MODAL_SCOPE_SELECTOR : COMPOSER_PAGE_SCOPE_SELECTOR;
  try {
    await pg.waitForFunction((requireReplyContext, requireDialog, textboxSelector, candidateSelector) => {
      const isVisible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          el.getAttribute('aria-hidden') !== 'true';
      };
      return Array.from(document.querySelectorAll(candidateSelector)).some((scope) => {
        const role = scope.getAttribute('role') || '';
        if (requireDialog && role !== 'dialog' && role !== 'group') return false;
        if (!isVisible(scope)) return false;

        const textbox = scope.querySelector(textboxSelector);
        if (!textbox || !isVisible(textbox)) return false;

        const buttons = Array.from(scope.querySelectorAll('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]'))
          .filter(isVisible);
        const scopeText = (scope.textContent || '').toLowerCase();
        const hasSubmitButton = buttons.some((button) => {
          const buttonText = `${button.textContent || ''} ${button.getAttribute('aria-label') || ''}`.toLowerCase();
          const testId = button.getAttribute('data-testid') || '';
          return testId === 'tweetButton' || testId === 'tweetButtonInline' || buttonText.includes('reply') || buttonText.includes('post');
        });
        return textbox && buttons.length > 0 && hasSubmitButton && (
          !requireReplyContext || scopeText.includes('replying to') || buttons.some((button) => {
            const buttonText = `${button.textContent || ''} ${button.getAttribute('aria-label') || ''}`.toLowerCase();
            return buttonText.includes('reply');
          })
        );
      });
    }, { timeout }, replyOnly, dialogOnly, COMPOSER_TEXTBOX_SELECTOR, scopeSelector);
  } catch {
    return null;
  }

  const scopes = await pg.$$(scopeSelector);
  for (const scope of scopes) {
    const isComposer = await scope.evaluate((el, requireReplyContext, requireDialog, textboxSelector) => {
      const role = el.getAttribute('role') || '';
      if (requireDialog && role !== 'dialog' && role !== 'group') return false;

      const isVisible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          node.getAttribute('aria-hidden') !== 'true';
      };
      if (!isVisible(el)) return false;

      const textbox = el.querySelector(textboxSelector);
      if (!textbox || !isVisible(textbox)) return false;

      const buttons = Array.from(el.querySelectorAll('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]'))
        .filter(isVisible);
      const scopeText = (el.textContent || '').toLowerCase();
      const hasSubmitButton = buttons.some((button) => {
        const buttonText = `${button.textContent || ''} ${button.getAttribute('aria-label') || ''}`.toLowerCase();
        const testId = button.getAttribute('data-testid') || '';
        return testId === 'tweetButton' || testId === 'tweetButtonInline' || buttonText.includes('reply') || buttonText.includes('post');
      });
      return Boolean(textbox && buttons.length > 0 && hasSubmitButton && (
        !requireReplyContext || scopeText.includes('replying to') || buttons.some((button) => {
          const buttonText = `${button.textContent || ''} ${button.getAttribute('aria-label') || ''}`.toLowerCase();
          return buttonText.includes('reply');
        })
      ));
    }, replyOnly, dialogOnly, COMPOSER_TEXTBOX_SELECTOR);
    if (isComposer) return scope;
  }

  return null;
}

async function findReplyComposerScope(pg, { timeout = 8000 } = {}) {
  return findComposerScope(pg, { timeout, replyOnly: true });
}

async function findEnabledTweetButtonInScope(scope) {
  const buttons = [
    ...await scope.$$('[data-testid="tweetButton"]'),
    ...await scope.$$('[data-testid="tweetButtonInline"]'),
  ];
  for (const candidate of buttons) {
    const canSubmit = await candidate.evaluate((el) => {
      const label = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
      const disabled = Boolean(
        el.disabled ||
        el.hasAttribute('disabled') ||
        el.getAttribute('aria-disabled') === 'true' ||
        el.closest('[aria-disabled="true"]'),
      );
      const rect = el.getBoundingClientRect();
      const visible = Boolean(
        document.contains(el) &&
        rect.width > 0 &&
        rect.height > 0 &&
        window.getComputedStyle(el).visibility !== 'hidden'
      );
      const isTweetButton = ['tweetButton', 'tweetButtonInline'].includes(el.getAttribute('data-testid') || '');
      return visible && !disabled && (isTweetButton || label.includes('reply') || label.includes('post') || label.includes('tweet') || label.includes('quote'));
    });
    if (canSubmit) return candidate;
  }
  return null;
}

async function getButtonDebug(button) {
  try {
    return await button.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      return {
        testid: el.getAttribute('data-testid') || '',
        text: clean(el.innerText || el.textContent),
        ariaLabel: el.getAttribute('aria-label') || '',
        disabled: Boolean(el.disabled || el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' || el.closest('[aria-disabled="true"]')),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      };
    });
  } catch (error) {
    return { error: error.message || String(error) };
  }
}

async function clickTweetButtonInScope(scope, { debugLabel = '' } = {}) {
  const button = await findEnabledTweetButtonInScope(scope);
  if (!button) return false;
  if (debugLabel) {
    logQuoteFlowStage(`${debugLabel}_button_candidate`, await getButtonDebug(button));
  }
  try {
    await button.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
  } catch {}
  await button.click();
  if (debugLabel) logQuoteFlowStage(`${debugLabel}_button_clicked`);
  return true;
}

async function getVisibleNoticeText(pg) {
  try {
    return await pg.evaluate(() => {
      const selectors = [
        '[data-testid="toast"]',
        '[role="alert"]',
        '[aria-live="assertive"]',
        '[aria-live="polite"]',
      ];
      const notices = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
      for (const notice of notices) {
        const rect = notice.getBoundingClientRect();
        const style = window.getComputedStyle(notice);
        const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        const text = (notice.innerText || notice.textContent || '').replace(/\s+/g, ' ').trim();
        if (visible && text) return text;
      }

      const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
      const relevantPatterns = [
        /this request looks like it might be automated/i,
        /something went wrong/i,
        /post failed/i,
        /could not (send|post)/i,
        /try again later/i,
        /rate limit/i,
      ];
      const match = relevantPatterns.find((pattern) => pattern.test(bodyText));
      return match ? bodyText.slice(0, 500) : '';
    });
  } catch {
    return '';
  }
}

function classifyPostNotice(text = '') {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  if (/this request looks like it might be automated/i.test(normalized)) {
    return { ok: false, message: 'X blocked the quote tweet as automated' };
  }
  if (/something went wrong|post failed|could not (send|post)|try again later|rate limit/i.test(normalized)) {
    return { ok: false, message: normalized.slice(0, 240) };
  }
  if (/(your post was sent|your post has been sent|post sent|posted|sent)/i.test(normalized)) {
    return { ok: true, message: normalized.slice(0, 240) };
  }

  return null;
}

function logQuoteFlowStage(stage, details = {}) {
  try {
    const safeDetails = Object.fromEntries(
      Object.entries(details)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 240) : value]),
    );
    const line = `[x_quote_tweet] ${stage} ${JSON.stringify(safeDetails)}`;
    console.error(line);
    if (process.env.XACTIONS_QUOTE_FLOW_LOG) {
      fs.appendFile(process.env.XACTIONS_QUOTE_FLOW_LOG, `${new Date().toISOString()} ${line}\n`).catch(() => {});
    }
  } catch {}
}

async function getComposerScopeDebug(scope) {
  try {
    return await scope.evaluate((el, textboxSelector) => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const rectFor = (node) => {
        const rect = node.getBoundingClientRect();
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      };
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };

      return {
        role: el.getAttribute('role') || '',
        rect: rectFor(el),
        textPreview: clean(el.innerText || el.textContent).slice(0, 280),
        textboxes: Array.from(el.querySelectorAll(textboxSelector))
          .filter(visible)
          .map((node) => ({
            testid: node.getAttribute('data-testid') || '',
            role: node.getAttribute('role') || '',
            ariaLabel: node.getAttribute('aria-label') || '',
            text: clean(node.innerText || node.textContent).slice(0, 180),
            rect: rectFor(node),
          })),
        buttons: Array.from(el.querySelectorAll('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]'))
          .filter(visible)
          .map((node) => ({
            testid: node.getAttribute('data-testid') || '',
            text: clean(node.innerText || node.textContent),
            ariaLabel: node.getAttribute('aria-label') || '',
            disabled: Boolean(node.disabled || node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true' || node.closest('[aria-disabled="true"]')),
            rect: rectFor(node),
          })),
      };
    }, COMPOSER_TEXTBOX_SELECTOR);
  } catch (error) {
    return { error: error.message || String(error) };
  }
}

async function getQuoteComposerReadiness(scope, { expectedText, tweetId, targetUsername } = {}) {
  try {
    return await scope.evaluate((el, args, textboxSelector) => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const rectFor = (node) => {
        const rect = node.getBoundingClientRect();
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      };
      const expected = clean(args.expectedText);
      const username = clean(args.targetUsername).replace(/^@/, '').toLowerCase();
      const tweetIdValue = clean(args.tweetId);
      const scopeText = clean(el.innerText || el.textContent);
      const scopeTextLower = scopeText.toLowerCase();
      const textboxes = Array.from(el.querySelectorAll(textboxSelector)).filter(visible);
      const textboxDetails = textboxes.map((node) => ({
        testid: node.getAttribute('data-testid') || '',
        role: node.getAttribute('role') || '',
        ariaLabel: node.getAttribute('aria-label') || '',
        text: clean(node.innerText || node.textContent),
        rect: rectFor(node),
      }));
      const draftTextMatches = textboxDetails.some((textbox) => textbox.text.includes(expected));
      const hrefs = Array.from(el.querySelectorAll('a[href]'))
        .map((node) => node.getAttribute('href') || '')
        .filter(Boolean);
      const hasTargetStatusLink = tweetIdValue
        ? hrefs.some((href) => {
            try {
              return new URL(href, window.location.origin).pathname.includes(`/status/${tweetIdValue}`);
            } catch {
              return href.includes(`/status/${tweetIdValue}`);
            }
          })
        : false;
      const hasTargetUsername = username
        ? scopeTextLower.includes(`@${username}`) || scopeTextLower.includes(username)
        : false;
      const quotePreviewNodes = Array.from(el.querySelectorAll('[data-testid="quoteTweet"], article[data-testid="tweet"], button, [role="button"], a[href*="/status/"]'))
        .filter((node) => visible(node))
        .map((node) => ({
          tagName: node.tagName,
          testid: node.getAttribute('data-testid') || '',
          role: node.getAttribute('role') || '',
          text: clean(node.innerText || node.textContent).slice(0, 240),
          href: node.getAttribute('href') || '',
          rect: rectFor(node),
        }));
      const hasQuoteLabel = /\bquote\b/i.test(scopeText);
      const hasQuotePreview = hasTargetStatusLink ||
        (hasQuoteLabel && hasTargetUsername) ||
        quotePreviewNodes.some((node) => {
          const nodeText = node.text.toLowerCase();
          return nodeText.includes('/status/') ||
            (username && (nodeText.includes(`@${username}`) || nodeText.includes(username))) ||
            (tweetIdValue && node.href.includes(`/status/${tweetIdValue}`));
        });
      const buttons = Array.from(el.querySelectorAll('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]'))
        .filter(visible)
        .map((node) => ({
          testid: node.getAttribute('data-testid') || '',
          text: clean(node.innerText || node.textContent),
          ariaLabel: node.getAttribute('aria-label') || '',
          disabled: Boolean(node.disabled || node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true' || node.closest('[aria-disabled="true"]')),
          rect: rectFor(node),
        }));

      return {
        ready: draftTextMatches && hasQuotePreview,
        draftTextMatches,
        hasQuotePreview,
        hasTargetStatusLink,
        hasTargetUsername,
        hasQuoteLabel,
        scopeTextPreview: scopeText.slice(0, 320),
        textboxes: textboxDetails,
        buttons,
        quotePreviewNodes: quotePreviewNodes.slice(0, 6),
      };
    }, { expectedText, tweetId, targetUsername }, COMPOSER_TEXTBOX_SELECTOR);
  } catch (error) {
    return {
      ready: false,
      error: error.message || String(error),
    };
  }
}

async function getQuoteFlowDebug(pg) {
  try {
    return await pg.evaluate((textboxSelector) => {
      const rectFor = (el) => {
        const rect = el.getBoundingClientRect();
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      };
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };

      return {
        url: window.location.href,
        activeElement: document.activeElement ? {
          tagName: document.activeElement.tagName,
          role: document.activeElement.getAttribute('role') || '',
          testid: document.activeElement.getAttribute('data-testid') || '',
          ariaLabel: document.activeElement.getAttribute('aria-label') || '',
          text: clean(document.activeElement.innerText || document.activeElement.textContent).slice(0, 280),
          rect: rectFor(document.activeElement),
        } : null,
        noticeText: clean(Array.from(document.querySelectorAll('[data-testid="toast"], [role="alert"], [aria-live="assertive"], [aria-live="polite"]'))
          .filter(visible)
          .map((el) => el.innerText || el.textContent || '')
          .find(Boolean) || ''),
        dialogs: Array.from(document.querySelectorAll('[role="dialog"], [role="group"]'))
          .filter(visible)
          .slice(0, 4)
          .map((el) => ({
            role: el.getAttribute('role'),
            text: clean(el.innerText || el.textContent).slice(0, 280),
            rect: rectFor(el),
          })),
        textboxes: Array.from(document.querySelectorAll(textboxSelector))
          .filter(visible)
          .map((el) => ({
            testid: el.getAttribute('data-testid'),
            text: clean(el.innerText || el.textContent).slice(0, 280),
            rect: rectFor(el),
          })),
        submitButtons: Array.from(document.querySelectorAll('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]'))
          .filter(visible)
          .map((el) => ({
            testid: el.getAttribute('data-testid'),
            text: clean(el.innerText || el.textContent),
            ariaLabel: el.getAttribute('aria-label') || '',
            disabled: Boolean(el.disabled || el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' || el.closest('[aria-disabled="true"]')),
            rect: rectFor(el),
          })),
        quotePreviewCount: document.querySelectorAll('[data-testid="quoteTweet"], [role="dialog"] article[data-testid="tweet"], [role="group"] article[data-testid="tweet"]').length,
      };
    }, COMPOSER_TEXTBOX_SELECTOR);
  } catch (error) {
    return { error: error.message || String(error) };
  }
}

async function composerStillHasText(scope, expectedText) {
  try {
    return await scope.evaluate((el, expected) => {
      if (!document.contains(el)) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      if (!visible) return false;
      const text = (el.innerText || el.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      return text.includes(String(expected || '').replace(/\s+/g, ' ').trim());
    }, expectedText);
  } catch {
    return false;
  }
}

async function waitForPostSubmissionResult(pg, scope, expectedText, { timeout = 15_000 } = {}) {
  const deadline = Date.now() + timeout;
  let sawComposer = true;
  let composerDisappeared = false;

  while (Date.now() < deadline) {
    const notice = classifyPostNotice(await getVisibleNoticeText(pg));
    if (notice) return notice;

    const composerHasDraft = await composerStillHasText(scope, expectedText);
    if (!composerHasDraft) {
      sawComposer = false;
      composerDisappeared = true;
    }

    await sleep(250);
  }

  if (sawComposer && await composerStillHasText(scope, expectedText)) {
    return {
      ok: false,
      message: 'Quote tweet was not submitted; composer still contains the draft',
    };
  }

  if (composerDisappeared) {
    return {
      ok: false,
      message: 'Quote tweet submission could not be confirmed by X',
    };
  }

  return {
    ok: false,
    message: 'Timed out waiting for quote tweet submission confirmation',
  };
}

async function clickButtonByText(pg, pattern, { timeout = 3000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const buttons = await pg.$$('button, [role="button"]');
    for (const button of buttons) {
      const matches = await button.evaluate((el, sourcePattern, flags) => {
        const re = new RegExp(sourcePattern, flags);
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        const disabled = Boolean(
          el.disabled ||
          el.hasAttribute('disabled') ||
          el.getAttribute('aria-disabled') === 'true' ||
          el.closest('[aria-disabled="true"]'),
        );
        const text = `${el.innerText || ''} ${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`;
        return visible && !disabled && re.test(text);
      }, pattern.source, pattern.flags);
      if (!matches) continue;

      try {
        await button.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
      } catch {}
      try {
        await button.click();
      } catch {
        await button.evaluate((el) => el.click());
      }
      return true;
    }

    await sleep(100);
  }

  return false;
}

async function closeQuoteComposer(pg) {
  const closeSelectors = [
    '[role="dialog"] [data-testid="app-bar-close"]',
    '[role="dialog"] button[aria-label="Close"]',
    '[role="group"] [data-testid="app-bar-close"]',
    '[role="group"] button[aria-label="Close"]',
    '[data-testid="app-bar-close"]',
    'button[aria-label="Close"]',
  ].join(', ');

  let closeClicked = false;
  const buttons = await pg.$$(closeSelectors).catch(() => []);
  for (const button of buttons) {
    const visible = await button.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        el.getAttribute('aria-hidden') !== 'true';
    }).catch(() => false);
    if (!visible) continue;

    try {
      await button.click();
      closeClicked = true;
      break;
    } catch {
      try {
        await button.evaluate((el) => el.click());
        closeClicked = true;
        break;
      } catch {}
    }
  }

  if (!closeClicked) {
    await pg.keyboard.press('Escape').catch(() => {});
    closeClicked = true;
  }

  await sleep(400);
  await clickButtonByText(pg, /^discard$/i, { timeout: 2500 });
  await sleep(700);
  return true;
}

async function waitForTweetButtonEnabled(scope, { timeout = 4000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await findEnabledTweetButtonInScope(scope)) return true;
    await sleep(100);
  }
  return false;
}

async function clearComposerText(pg, composer) {
  if (!await composerHasText(composer)) return true;

  try {
    await pg.bringToFront?.();
  } catch {}
  await composer.focus();
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  try {
    await pg.keyboard.down(modifier);
    await pg.keyboard.press('A');
    await pg.keyboard.up(modifier);
    await pg.keyboard.press('Backspace');
  } catch {}
  await composer.evaluate((el) => {
    el.focus();
    const selection = window.getSelection?.();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.execCommand('delete', false, null);
    if ((el.innerText || el.textContent || '').trim().length > 0) {
      el.textContent = '';
    }
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'deleteContentBackward',
    }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(250);
  return !await composerHasText(composer);
}

async function insertTextWithExecCommand(composer, value) {
  return composer.evaluate((el, input) => {
    el.focus();
    const beforeInput = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: input,
    });
    el.dispatchEvent(beforeInput);
    const ok = document.execCommand('insertText', false, input);
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: input,
    }));
    const currentText = el.innerText || el.textContent || '';
    return ok || currentText.includes(input);
  }, value);
}

async function insertTextCharacterByCharacter(composer, value, { delay = 30 } = {}) {
  for (const char of String(value || '')) {
    const inserted = await composer.evaluate((el, input) => {
      el.focus();
      const beforeInput = new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: input,
      });
      el.dispatchEvent(beforeInput);
      const ok = document.execCommand('insertText', false, input);
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: input,
      }));
      return ok || (el.innerText || el.textContent || '').includes(input);
    }, char);
    if (!inserted) return false;
    if (delay > 0) await sleep(delay);
  }
  return true;
}

async function insertTextWithKeyboard(pg, composer, value, { delay = 20 } = {}) {
  try {
    await pg.bringToFront?.();
  } catch {}
  try {
    await composer.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
  } catch {}
  await composer.focus();
  await composer.click({ delay: 50 });
  await sleep(100);
  await pg.keyboard.type(value, { delay });
  return composerHasText(composer, value);
}

async function waitForComposerTextState(composer, predicate, { timeout = 2000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const text = await getComposerText(composer);
    if (predicate(text)) return true;
    await sleep(100);
  }
  return false;
}

async function insertTextWithPrimedKeyboard(pg, composer, value, { delay = 60 } = {}) {
  try {
    await pg.bringToFront?.();
  } catch {}
  try {
    await composer.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
  } catch {}
  await composer.focus();
  await composer.click({ delay: 50 });
  await sleep(500);

  await pg.keyboard.type('x', { delay: 20 });
  const acceptsTyping = await waitForComposerTextState(composer, (text) => text.includes('x'), {
    timeout: 2500,
  });
  if (!acceptsTyping) return false;

  if (!await clearComposerText(pg, composer)) return false;

  await composer.focus();
  await composer.click({ delay: 50 });
  await sleep(300);
  await pg.keyboard.type(value, { delay });
  await sleep(500);
  return composerHasText(composer, value);
}

async function insertTextWithSendCharacter(pg, composer, value) {
  try {
    await pg.bringToFront?.();
  } catch {}
  try {
    await composer.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
  } catch {}
  await composer.focus();
  await composer.click({ delay: 50 });
  await sleep(100);
  for (const char of String(value || '')) {
    await pg.keyboard.sendCharacter(char);
    await sleep(5);
  }
  await sleep(300);
  return composerHasText(composer, value);
}

async function insertTextWithClipboardPaste(pg, composer, value) {
  try {
    await pg.browserContext?.().overridePermissions?.('https://x.com', [
      'clipboard-read',
      'clipboard-write',
    ]);
  } catch {}

  try {
    await pg.bringToFront?.();
  } catch {}
  try {
    await composer.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
  } catch {}
  await composer.focus();
  await composer.click({ delay: 50 });
  await sleep(100);

  try {
    await withTimeout(
      pg.evaluate((text) => navigator.clipboard.writeText(text), value),
      3000,
    );
  } catch {
    return false;
  }

  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await pg.keyboard.down(modifier);
  await pg.keyboard.press('V');
  await pg.keyboard.up(modifier);
  await sleep(250);
  return composerHasText(composer, value);
}

async function insertTextWithNativeInput(pg, composer, value) {
  try {
    await pg.bringToFront?.();
  } catch {}
  try {
    await composer.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
  } catch {}
  await composer.focus();
  await composer.click({ delay: 50 });
  await sleep(100);

  let client = null;
  try {
    if (typeof pg.target === 'function') {
      client = await pg.target().createCDPSession();
      await withTimeout(client.send('Input.insertText', { text: value }), 3000);
    } else if (typeof pg._client === 'function') {
      await withTimeout(pg._client().send('Input.insertText', { text: value }), 3000);
    } else {
      return false;
    }
  } finally {
    try {
      await client?.detach?.();
    } catch {}
  }

  return composerHasText(composer, value);
}

async function insertTextWithDispatchKeyEvents(pg, composer, value) {
  try {
    await pg.bringToFront?.();
  } catch {}
  try {
    await composer.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
  } catch {}
  await composer.focus();
  await composer.click({ delay: 50 });
  await sleep(100);

  let client = null;
  try {
    if (typeof pg.target === 'function') {
      client = await pg.target().createCDPSession();
    } else if (typeof pg._client === 'function') {
      client = pg._client();
    } else {
      return false;
    }

    for (const char of String(value || '')) {
      await withTimeout(client.send('Input.dispatchKeyEvent', {
        type: 'char',
        text: char,
        unmodifiedText: char,
      }), 3000);
      await sleep(5);
    }
  } finally {
    try {
      await client?.detach?.();
    } catch {}
  }

  await sleep(300);
  return composerHasText(composer, value);
}

async function getComposerText(composer) {
  try {
    return await composer.evaluate((el) => (el.innerText || el.textContent || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim());
  } catch {
    return '';
  }
}

async function composerHasText(composer, expectedText = '') {
  return composer.evaluate((el, expected) => {
    const normalize = (value) => String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const currentText = normalize(el.innerText || el.textContent || '');
    if (!expected) return currentText.length > 0;
    return currentText.includes(normalize(expected));
  }, expectedText);
}

async function getComposerInputDebug(composer) {
  try {
    return await composer.evaluate((el) => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const active = document.activeElement;
      return {
        isConnected: document.contains(el),
        isActiveElement: active === el,
        activeElement: active ? {
          tagName: active.tagName,
          role: active.getAttribute('role') || '',
          testid: active.getAttribute('data-testid') || '',
          ariaLabel: active.getAttribute('aria-label') || '',
          text: clean(active.innerText || active.textContent).slice(0, 180),
        } : null,
      };
    });
  } catch (error) {
    return { error: error.message || String(error) };
  }
}

async function nudgeComposerInput(composer) {
  return composer.evaluate((el) => {
    const currentText = (el.innerText || el.textContent || '').replace(/\u00a0/g, ' ');
    el.focus();
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: currentText,
    }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return currentText;
  });
}

async function insertComposerText(pg, composer, text, { delay = 30, scope = null, allowDomFallback = true } = {}) {
  const value = String(text || '');
  if (!value) return false;
  const buttonEnableTimeout = Math.max(1500, Math.min(3000, 500 + (value.length * 5)));
  const fallbackDelay = Math.max(10, Math.min(delay, 30));
  const recordAttempt = async (method, ok, error = null) => {
    logQuoteFlowStage('quote_text_insert_attempt', {
      method,
      ok,
      error: error?.message || null,
      textAfter: await getComposerText(composer),
      inputDebug: await getComposerInputDebug(composer),
    });
  };
  const waitForComposerReady = async () => {
    if (!await composerHasText(composer, value)) return false;
    if (!scope) return true;
    await nudgeComposerInput(composer);
    return waitForTweetButtonEnabled(scope, { timeout: buttonEnableTimeout });
  };

  await composer.focus();
  if (scope) await clearComposerText(pg, composer);

  try {
    await insertTextWithClipboardPaste(pg, composer, value);
    const ok = await waitForComposerReady();
    await recordAttempt('clipboard-paste', ok);
    if (ok) return true;
  } catch (error) {
    await recordAttempt('clipboard-paste', false, error);
  }

  if (scope) await clearComposerText(pg, composer);

  try {
    await insertTextWithNativeInput(pg, composer, value);
    const ok = await waitForComposerReady();
    await recordAttempt('native-input', ok);
    if (ok) return true;
  } catch (error) {
    await recordAttempt('native-input', false, error);
  }

  try {
    await insertTextWithPrimedKeyboard(pg, composer, value, { delay: Math.max(50, fallbackDelay) });
    const ok = await waitForComposerReady();
    await recordAttempt('primed-keyboard-type', ok);
    if (ok) return true;
  } catch (error) {
    await recordAttempt('primed-keyboard-type', false, error);
  }

  if (!allowDomFallback) return false;

  if (scope) await clearComposerText(pg, composer);

  try {
    await insertTextWithSendCharacter(pg, composer, value);
    const ok = await waitForComposerReady();
    await recordAttempt('send-character', ok);
    if (ok) return true;
  } catch (error) {
    await recordAttempt('send-character', false, error);
  }

  if (scope) await clearComposerText(pg, composer);

  try {
    await insertTextWithDispatchKeyEvents(pg, composer, value);
    const ok = await waitForComposerReady();
    await recordAttempt('cdp-char-events', ok);
    if (ok) return true;
  } catch (error) {
    await recordAttempt('cdp-char-events', false, error);
  }

  if (scope) await clearComposerText(pg, composer);

  try {
    await insertTextWithKeyboard(pg, composer, value, { delay: fallbackDelay });
    const ok = await waitForComposerReady();
    await recordAttempt('keyboard-type', ok);
    if (ok) return true;
  } catch (error) {
    await recordAttempt('keyboard-type', false, error);
  }

  if (scope) await clearComposerText(pg, composer);

  try {
    await composer.type(value, { delay: fallbackDelay });
    const ok = await waitForComposerReady();
    await recordAttempt('element-type', ok);
    if (ok) return true;
  } catch (error) {
    await recordAttempt('element-type', false, error);
  }

  if (scope) await clearComposerText(pg, composer);

  try {
    await insertTextWithExecCommand(composer, value);
    const ok = await waitForComposerReady();
    await recordAttempt('exec-command', ok);
    if (ok) return true;
  } catch (error) {
    await recordAttempt('exec-command', false, error);
  }

  if (scope) await clearComposerText(pg, composer);

  try {
    await insertTextCharacterByCharacter(composer, value, { delay: fallbackDelay });
    const ok = await waitForComposerReady();
    await recordAttempt('exec-command-character', ok);
    if (ok) return true;
  } catch (error) {
    await recordAttempt('exec-command-character', false, error);
  }

  return !scope;
}

function normalizeTweetUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (/^\d{5,}$/.test(value)) return `https://x.com/i/status/${value}`;
  if (value.startsWith('/')) return `https://x.com${value}`;
  return value.replace(/^https?:\/\/(?:www\.)?twitter\.com/i, 'https://x.com');
}

function tweetIdFromUrl(url) {
  const value = String(url || '').trim();
  if (/^\d{5,}$/.test(value)) return value;
  return value.match(/\/(?:i\/web\/|i\/)?status\/(\d+)/)?.[1] ||
    value.match(/[?&](?:tweet_id|in_reply_to)=(\d+)/)?.[1] ||
    null;
}

function tweetUsernameFromUrl(url) {
  try {
    const parsed = new URL(normalizeTweetUrl(url));
    const [username, segment] = parsed.pathname.split('/').filter(Boolean);
    return segment === 'status' ? username : null;
  } catch {
    return String(url || '').match(/(?:x|twitter)\.com\/([^/?#]+)\/status\/\d+/i)?.[1] || null;
  }
}

function normalizeTweetTarget({ url, tweetUrl, tweetId } = {}) {
  const raw = url || tweetUrl || tweetId || '';
  const id = tweetIdFromUrl(raw);
  return {
    tweetId: id,
    url: normalizeTweetUrl(raw || (id ? `https://x.com/i/status/${id}` : '')),
    username: tweetUsernameFromUrl(raw),
  };
}

async function findTweetArticleById(pg, tweetId) {
  if (!tweetId) return null;

  const articles = await pg.$$(TWEET_ARTICLE_SELECTOR);
  for (const article of articles) {
    const matches = await article.evaluate((el, id) => {
      return Array.from(el.querySelectorAll('a[href*="/status/"]'))
        .some((a) => {
          const href = a.getAttribute('href') || '';
          try {
            const pathname = new URL(href, window.location.origin).pathname;
            return pathname.includes(`/status/${id}`);
          } catch {
            return href.includes(`/status/${id}`);
          }
        });
    }, tweetId);
    if (matches) return article;
  }

  return null;
}

async function findTweetArticleByUrl(pg, url) {
  return findTweetArticleById(pg, tweetIdFromUrl(url));
}

async function waitForTweetArticleById(pg, tweetId, { timeout = DEFAULT_TWEET_TARGET_TIMEOUT_MS } = {}) {
  if (!tweetId) return null;

  try {
    await pg.waitForFunction((id) => {
      const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
      return articles.some((article) => {
        return Array.from(article.querySelectorAll('a[href*="/status/"]')).some((a) => {
          const href = a.getAttribute('href') || '';
          try {
            const pathname = new URL(href, window.location.origin).pathname;
            return pathname.includes(`/status/${id}`);
          } catch {
            return href.includes(`/status/${id}`);
          }
        });
      });
    }, { timeout }, tweetId);
  } catch {
    await pg.waitForSelector(TWEET_ARTICLE_SELECTOR, { timeout: 1000 }).catch(() => {});
  }

  return findTweetArticleById(pg, tweetId);
}

async function stopPageLoading(pg) {
  try {
    await pg.evaluate(() => window.stop());
  } catch {}
}

async function recoverAfterTweetTargetMiss(pg) {
  await stopPageLoading(pg);
  try {
    await pg.goto('about:blank', {
      waitUntil: 'domcontentloaded',
      timeout: 5000,
    });
  } catch {
    await closeBrowser();
  }
}

async function getTweetActionScope(pg, url, { timeout = DEFAULT_TWEET_TARGET_TIMEOUT_MS } = {}) {
  const tweetId = tweetIdFromUrl(url);
  const targetArticle = await waitForTweetArticleById(pg, tweetId, { timeout });
  return {
    tweetId,
    targetArticle,
    scope: targetArticle || (tweetId ? null : pg),
  };
}

async function getQuoteTargetActionScope(pg, targetUrl, tweetId) {
  const canonicalUrl = `https://x.com/i/status/${tweetId}`;
  const attemptUrls = Array.from(new Set([targetUrl, canonicalUrl].filter(Boolean)));

  for (const [index, attemptUrl] of attemptUrls.entries()) {
    logQuoteFlowStage('target_navigation_attempt', {
      targetUrl,
      tweetId,
      attemptUrl,
      attempt: index + 1,
    });

    await gotoX(pg, attemptUrl, Math.min(getNavigationTimeoutMs(), 12_000), { retries: 0 });
    await randomDelay(800, 1500);

    const result = await getTweetActionScope(pg, attemptUrl, { timeout: 12_000 });
    if (result.scope) {
      logQuoteFlowStage('target_scope_found', {
        targetUrl,
        tweetId,
        attemptUrl,
        attempt: index + 1,
      });
      return result;
    }

    logQuoteFlowStage('target_scope_attempt_missing', {
      targetUrl,
      tweetId,
      attemptUrl,
      attempt: index + 1,
      debug: await getQuoteFlowDebug(pg),
    });
    await stopPageLoading(pg);
    await sleep(500);
  }

  return { tweetId, targetArticle: null, scope: null };
}

async function openReplyComposer(pg, { url, tweetId, text }) {
  await gotoX(pg, `https://x.com/intent/tweet?in_reply_to=${encodeURIComponent(tweetId)}`);
  await randomDelay();

  let replyScope = await findReplyComposerScope(pg, { timeout: 10_000 });
  if (!replyScope) {
    await gotoX(pg, url || `https://x.com/i/status/${tweetId}`);
    await randomDelay();

    const { scope } = await getTweetActionScope(pg, url || `https://x.com/i/status/${tweetId}`);
    if (!scope) return null;

    const replyButton = await scope.$('[data-testid="reply"]');
    if (!replyButton) return null;
    await replyButton.click();
    await sleep(750);
    replyScope = await findReplyComposerScope(pg, { timeout: 10_000 });
  }

  const replyBox = await replyScope?.$(COMPOSER_TEXTBOX_SELECTOR);
  if (!replyBox) return null;

  await replyBox.type(text, { delay: 50 });
  await sleep(500);
  return replyScope;
}

async function openQuoteComposer(pg, { url, tweetId, text, attempt = 1 }) {
  const targetUrl = url || `https://x.com/i/status/${tweetId}`;
  logQuoteFlowStage('opening_target', { targetUrl, tweetId, attempt });

  const { scope } = await getQuoteTargetActionScope(pg, targetUrl, tweetId);
  if (!scope) {
    logQuoteFlowStage('target_scope_missing', { targetUrl, tweetId });
    return null;
  }

  const retweetButton = await scope.$('[data-testid="retweet"], [data-testid="unretweet"]');
  if (!retweetButton) {
    logQuoteFlowStage('retweet_button_missing', { targetUrl, tweetId });
    return null;
  }
  logQuoteFlowStage('retweet_button_candidate', await getButtonDebug(retweetButton));

  try {
    await retweetButton.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
  } catch {}
  await retweetButton.click();
  logQuoteFlowStage('retweet_menu_clicked', { targetUrl, tweetId });
  await sleep(800);

  const quoteSelected = await clickQuoteMenuItem(pg, { timeout: 3000 });
  if (!quoteSelected) {
    logQuoteFlowStage('quote_menu_item_missing', { targetUrl, tweetId });
    try {
      await pg.mouse.click(1, 1);
    } catch {}
    return null;
  }
  logQuoteFlowStage('quote_menu_item_clicked', { targetUrl, tweetId, selected: quoteSelected });

  try {
    await pg.waitForFunction(() => window.location.pathname === '/compose/post', { timeout: 4000 });
  } catch {
    logQuoteFlowStage('quote_compose_route_missing_after_menu_click', {
      targetUrl,
      tweetId,
      debug: await getQuoteFlowDebug(pg),
    });
    return null;
  }

  const quoteScope = await findComposerScope(pg, { timeout: 6000, dialogOnly: true });
  const quoteBox = await quoteScope?.$(COMPOSER_TEXTBOX_SELECTOR);
  if (!quoteBox) {
    logQuoteFlowStage('quote_composer_missing', { targetUrl, tweetId });
    return null;
  }
  logQuoteFlowStage('quote_composer_found', await getComposerScopeDebug(quoteScope));

  const existingDraft = await getComposerText(quoteBox);
  if (existingDraft && !String(text || '').includes(existingDraft) && !existingDraft.includes(String(text || '').trim())) {
    logQuoteFlowStage('quote_stale_draft_found', {
      targetUrl,
      tweetId,
      attempt,
      existingDraft,
    });
    await closeQuoteComposer(pg);
    if (attempt < 2) {
      return openQuoteComposer(pg, { url, tweetId, text, attempt: attempt + 1 });
    }
    return null;
  }

  const inserted = await insertComposerText(pg, quoteBox, text, {
    delay: 20,
    scope: quoteScope,
    allowDomFallback: false,
  });
  if (!inserted) {
    logQuoteFlowStage('quote_text_insert_failed', {
      targetUrl,
      tweetId,
      textLength: String(text || '').length,
      debug: await getComposerScopeDebug(quoteScope),
    });
    await closeQuoteComposer(pg);
    return null;
  }
  const readiness = await getQuoteComposerReadiness(quoteScope, {
    expectedText: text,
    tweetId,
    targetUsername: tweetUsernameFromUrl(targetUrl),
  });
  if (!readiness.ready) {
    logQuoteFlowStage('quote_composer_preflight_failed_after_insert', {
      targetUrl,
      tweetId,
      readiness,
    });
    await closeQuoteComposer(pg);
    return null;
  }
  logQuoteFlowStage('quote_text_inserted', {
    targetUrl,
    tweetId,
    textLength: String(text || '').length,
    readiness,
  });

  await sleep(500);
  return quoteScope;
}

/**
 * Scroll-and-collect pattern using a Map for dedup.
 * @param {Object} pg - Puppeteer page
 * @param {Function} extractFn - page.evaluate callback returning [{key, ...data}]
 * @param {Object} opts
 */
async function scrollCollect(pg, extractFn, { limit = 100, maxRetries = 10 } = {}) {
  const collected = new Map();
  let retries = 0;

  while (collected.size < limit && retries < maxRetries) {
    const items = await pg.evaluate(extractFn);
    const prev = collected.size;
    items.forEach((item) => {
      if (item._key) {
        collected.set(item._key, item);
      }
    });
    if (collected.size === prev) retries++;
    else retries = 0;

    await pg.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await randomDelay(1500, 3000);
  }

  return Array.from(collected.values())
    .map(({ _key, ...rest }) => rest)
    .slice(0, limit);
}

// ============================================================================
// 1. Auth
// ============================================================================

export async function x_login({ cookie }) {
  const { page: pg } = await ensureBrowser({ authenticate: false });
  await setSessionCookies(pg, cookie);
  await gotoX(pg, 'https://x.com/home');
  authenticatedCookie = cookie;
  return { success: true, message: 'Logged in with session cookie' };
}

// ============================================================================
// 2–7. Scraping — delegated to ../scrapers (single source of truth)
// ============================================================================

export async function x_get_profile({ username }) {
  const { page: pg } = await ensureBrowser();
  return scrapeProfile(pg, username);
}

export async function x_get_followers({ username, limit = 100 }) {
  const { page: pg } = await ensureBrowser();
  return scrapeFollowers(pg, username, { limit });
}

export async function x_get_following({ username, limit = 100 }) {
  const { page: pg } = await ensureBrowser();
  return scrapeFollowing(pg, username, { limit });
}

export async function x_get_non_followers({ username }) {
  const { page: pg } = await ensureBrowser();
  const followers = await scrapeFollowers(pg, username, { limit: 5000 });
  const following = await scrapeFollowing(pg, username, { limit: 5000 });

  const followerSet = new Set(followers.map((f) => f.username));
  const nonFollowers = following.filter((f) => !followerSet.has(f.username));

  return {
    nonFollowers: nonFollowers.map((f) => f.username),
    count: nonFollowers.length,
    totalFollowing: following.length,
    totalFollowers: followers.length,
  };
}

export async function x_get_tweets({ username, limit = 50 }) {
  if (process.env.XACTIONS_SCRAPER_ADAPTER === 'http') {
    const scraper = await getHttpScraper();
    const tweets = await scraper.scrapeTweets(username, { limit });
    return tweets.map((tweet) => ({
      ...tweet,
      url: buildTweetUrl(tweet, username),
    }));
  }

  const { page: pg } = await ensureBrowser();
  return scrapeTweets(pg, username, { limit });
}

export async function x_search_tweets({ query, limit = 50 }) {
  if (process.env.XACTIONS_SCRAPER_ADAPTER === 'http') {
    const scraper = await getHttpScraper();
    const tweets = await scraper.searchTweets(query, { limit });
    return tweets.map((tweet) => {
      const authorUsername = normalizeUsername(tweet?.author?.username || tweet?.authorUsername || tweet?.username || '');
      const url = tweet?.url || (
        tweet?.id && authorUsername
          ? `https://x.com/${authorUsername}/status/${tweet.id}`
          : null
      );
      return {
        ...tweet,
        author: authorUsername || tweet?.author?.name || tweet?.author || '',
        authorUsername,
        username: authorUsername,
        url,
        likes: tweet?.metrics?.likes ?? tweet?.likes ?? 0,
      };
    });
  }

  const { page: pg } = await ensureBrowser();
  return searchTweets(pg, query, { limit });
}

// ============================================================================
// 7b. Thread / Best Time to Post
// ============================================================================

export async function x_get_thread({ url }) {
  const { page: pg } = await ensureBrowser();
  return scrapeThread(pg, url);
}

export async function x_best_time_to_post({ username, limit = 100 }) {
  const { page: pg } = await ensureBrowser();
  const tweets = await scrapeTweets(pg, username, { limit });

  if (!tweets || !tweets.length) {
    return { error: `No tweets found for @${username}` };
  }

  const hourBuckets = Array.from({ length: 24 }, () => ({ count: 0, totalEngagement: 0 }));
  const dayBuckets = Array.from({ length: 7 }, () => ({ count: 0, totalEngagement: 0 }));
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  for (const tweet of tweets) {
    const dateStr = tweet.time || tweet.timestamp || tweet.date;
    if (!dateStr) continue;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) continue;

    const hour = d.getUTCHours();
    const day = d.getUTCDay();
    const engagement = (parseInt(tweet.likes) || 0) + (parseInt(tweet.retweets) || 0) + (parseInt(tweet.replies) || 0);

    hourBuckets[hour].count++;
    hourBuckets[hour].totalEngagement += engagement;
    dayBuckets[day].count++;
    dayBuckets[day].totalEngagement += engagement;
  }

  const bestHours = hourBuckets
    .map((b, i) => ({ hour: i, ...b, avgEngagement: b.count ? (b.totalEngagement / b.count) : 0 }))
    .filter(b => b.count > 0)
    .sort((a, b) => b.avgEngagement - a.avgEngagement)
    .slice(0, 5);

  const bestDays = dayBuckets
    .map((b, i) => ({ day: dayNames[i], ...b, avgEngagement: b.count ? (b.totalEngagement / b.count) : 0 }))
    .filter(b => b.count > 0)
    .sort((a, b) => b.avgEngagement - a.avgEngagement);

  return {
    username,
    tweetsAnalyzed: tweets.length,
    bestHoursUTC: bestHours.map(h => ({ hour: `${h.hour}:00 UTC`, posts: h.count, avgEngagement: Math.round(h.avgEngagement) })),
    bestDays: bestDays.map(d => ({ day: d.day, posts: d.count, avgEngagement: Math.round(d.avgEngagement) })),
    recommendation: bestHours.length
      ? `Post around ${bestHours[0].hour}:00 UTC on ${bestDays[0]?.day || 'any day'} for best engagement`
      : 'Not enough data to recommend',
  };
}

// ============================================================================
// 8–9. Follow / Unfollow
// ============================================================================

export async function x_follow({ username }) {
  const { page: pg } = await ensureBrowser();
  await gotoX(pg, `https://x.com/${username}`);
  await randomDelay();

  // The follow button is the primary action in the placement tracking area,
  // but only if the user isn't already followed (no -unfollow testid).
  const followBtn = await pg.$('[data-testid="placementTracking"] [role="button"]:not([data-testid$="-unfollow"])');
  if (followBtn) {
    await followBtn.click();
    await randomDelay();
    return { success: true, message: `Followed @${username}` };
  }
  return { success: false, message: `Could not follow @${username}` };
}

export async function x_unfollow({ username }) {
  const { page: pg } = await ensureBrowser();
  await gotoX(pg, `https://x.com/${username}`);
  await randomDelay();

  if (await clickIfPresent(pg, '[data-testid$="-unfollow"]')) {
    await sleep(500);
    await clickIfPresent(pg, '[data-testid="confirmationSheetConfirm"]');
    await randomDelay();
    return { success: true, message: `Unfollowed @${username}` };
  }
  return { success: false, message: `Could not unfollow @${username}` };
}

// ============================================================================
// 10–11. Bulk Operations
// ============================================================================

export async function x_unfollow_non_followers({ username, maxUnfollows = 100, dryRun = false }) {
  const result = await x_get_non_followers({ username });
  const toUnfollow = result.nonFollowers.slice(0, maxUnfollows);

  if (dryRun) {
    return { dryRun: true, wouldUnfollow: toUnfollow, count: toUnfollow.length };
  }

  const results = [];
  for (const user of toUnfollow) {
    const r = await x_unfollow({ username: user });
    results.push({ username: user, ...r });
    await sleep(2000); // Rate-limit protection
  }

  return {
    unfollowed: results.filter((r) => r.success).map((r) => r.username),
    failed: results.filter((r) => !r.success).map((r) => r.username),
    count: results.filter((r) => r.success).length,
  };
}

export async function x_detect_unfollowers({ username }) {
  const { page: pg } = await ensureBrowser();
  const followers = await scrapeFollowers(pg, username, { limit: 1000 });
  return {
    username,
    currentFollowers: followers.map((f) => f.username),
    count: followers.length,
    timestamp: new Date().toISOString(),
    note: 'Compare with previous snapshot to detect unfollowers',
  };
}

// ============================================================================
// 12–14. Post / Like / Retweet
// ============================================================================

export async function x_post_tweet({ text }) {
  const { page: pg } = await ensureBrowser();
  await gotoX(pg, 'https://x.com/compose/tweet');
  await randomDelay();

  const textbox = await pg.$('[data-testid="tweetTextarea_0"]');
  if (textbox) {
    await textbox.type(text, { delay: 50 });
    await sleep(500);
    if (await clickIfPresent(pg, '[data-testid="tweetButton"]')) {
      await randomDelay();
      return { success: true, message: 'Tweet posted successfully' };
    }
  }
  return { success: false, message: 'Could not post tweet' };
}

export async function x_like({ url, tweetUrl }) {
  const target = normalizeTweetTarget({ url, tweetUrl });
  if (!target.tweetId || !target.url) {
    return { success: false, message: 'Invalid tweet URL: expected /status/<id>' };
  }

  const { page: pg } = await ensureBrowser();
  await gotoX(pg, target.url);
  await randomDelay();

  const { targetArticle, scope } = await getTweetActionScope(pg, target.url);
  if (!scope) {
    await recoverAfterTweetTargetMiss(pg);
    return { success: false, message: 'Could not find target tweet', targetTweetId: target.tweetId, targetUrl: target.url };
  }
  if (targetArticle && await targetArticle.$('[data-testid="unlike"]')) {
    return { success: true, message: 'Tweet already liked', targetTweetId: target.tweetId, targetUrl: target.url };
  }

  const likeButton = await scope.$('[data-testid="like"]');
  if (likeButton) {
    await likeButton.click();
    await randomDelay();
    return { success: true, message: 'Tweet liked', targetTweetId: target.tweetId, targetUrl: target.url };
  }
  return { success: false, message: 'Could not like tweet', targetTweetId: target.tweetId, targetUrl: target.url };
}

export async function x_retweet({ url, tweetUrl }) {
  const target = normalizeTweetTarget({ url, tweetUrl });
  if (!target.tweetId || !target.url) {
    return { success: false, message: 'Invalid tweet URL: expected /status/<id>' };
  }

  const { page: pg } = await ensureBrowser();
  await gotoX(pg, target.url);
  await randomDelay();

  const { targetArticle, scope } = await getTweetActionScope(pg, target.url);
  if (!scope) {
    await recoverAfterTweetTargetMiss(pg);
    return { success: false, message: 'Could not find target tweet', targetTweetId: target.tweetId, targetUrl: target.url };
  }
  if (targetArticle && await targetArticle.$('[data-testid="unretweet"]')) {
    return { success: true, message: 'Tweet already retweeted', targetTweetId: target.tweetId, targetUrl: target.url };
  }

  const retweetButton = await scope.$('[data-testid="retweet"]');
  if (retweetButton) {
    await retweetButton.click();
    await sleep(500);
    await clickIfPresent(pg, '[data-testid="retweetConfirm"]');
    await randomDelay();
    return { success: true, message: 'Retweeted', targetTweetId: target.tweetId, targetUrl: target.url };
  }
  return { success: false, message: 'Could not retweet', targetTweetId: target.tweetId, targetUrl: target.url };
}

export async function x_quote_tweet({ url, tweetUrl, text, dryRun = false }) {
  const target = normalizeTweetTarget({ url, tweetUrl });
  if (!target.tweetId || !target.url) {
    return { success: false, message: 'Invalid tweet URL: expected /status/<id>' };
  }
  if (typeof text !== 'string' || text.length === 0) {
    return { success: false, message: 'Quote text is required' };
  }

  const { page: pg } = await ensureBrowser();
  let quoteScope = null;
  try {
    quoteScope = await openQuoteComposer(pg, {
      url: target.url,
      tweetId: target.tweetId,
      text,
    });
  } catch (error) {
    logQuoteFlowStage('quote_flow_error', {
      targetUrl: target.url,
      tweetId: target.tweetId,
      message: error.message || String(error),
    });
    const debug = await getQuoteFlowDebug(pg);
    await recoverAfterTweetTargetMiss(pg);
    return {
      success: false,
      message: `Quote tweet flow failed: ${error.message || String(error)}`,
      targetTweetId: target.tweetId,
      targetUrl: target.url,
      debug,
    };
  }
  if (!quoteScope) {
    const debug = await getQuoteFlowDebug(pg);
    await recoverAfterTweetTargetMiss(pg);
    return {
      success: false,
      message: 'Could not open quote tweet composer for target tweet',
      targetTweetId: target.tweetId,
      targetUrl: target.url,
      debug,
    };
  }

  if (dryRun) {
    const debug = await getComposerScopeDebug(quoteScope);
    const readiness = await getQuoteComposerReadiness(quoteScope, {
      expectedText: text,
      tweetId: target.tweetId,
      targetUsername: target.username,
    });
    await closeQuoteComposer(pg);
    logQuoteFlowStage('quote_dry_run_complete', {
      targetUrl: target.url,
      tweetId: target.tweetId,
      textLength: text.length,
      readiness,
    });
    return {
      success: readiness.ready,
      dryRun: true,
      message: readiness.ready
        ? 'Quote composer opened, draft inserted, quote preview verified, and composer discarded without posting'
        : 'Quote composer dry-run failed preflight and was discarded without posting',
      targetTweetId: target.tweetId,
      targetUrl: target.url,
      text,
      readiness,
      debug,
    };
  }

  const readiness = await getQuoteComposerReadiness(quoteScope, {
    expectedText: text,
    tweetId: target.tweetId,
    targetUsername: target.username,
  });
  if (!readiness.ready) {
    logQuoteFlowStage('quote_pre_post_preflight_failed', {
      targetUrl: target.url,
      tweetId: target.tweetId,
      readiness,
    });
    return {
      success: false,
      message: 'Refusing to click Post because the quote composer did not contain both the draft text and target quote preview',
      targetTweetId: target.tweetId,
      targetUrl: target.url,
      text,
      readiness,
      debug: await getQuoteFlowDebug(pg),
    };
  }

  if (await clickTweetButtonInScope(quoteScope, { debugLabel: 'quote_post' })) {
    const submission = await waitForPostSubmissionResult(pg, quoteScope, text, { timeout: 10_000 });
    if (!submission.ok) {
      logQuoteFlowStage('quote_submission_failed', {
        targetUrl: target.url,
        tweetId: target.tweetId,
        message: submission.message || 'Could not post quote tweet',
      });
      return {
        success: false,
        message: submission.message || 'Could not post quote tweet',
        targetTweetId: target.tweetId,
        targetUrl: target.url,
        text,
        debug: await getQuoteFlowDebug(pg),
      };
    }

    logQuoteFlowStage('quote_submission_confirmed', {
      targetUrl: target.url,
      tweetId: target.tweetId,
      message: submission.message || 'Quote tweet posted',
    });
    return {
      success: true,
      message: submission.message || 'Quote tweet posted',
      quotedUrl: target.url,
      targetTweetId: target.tweetId,
      text,
    };
  }

  logQuoteFlowStage('quote_post_button_missing', {
    targetUrl: target.url,
    tweetId: target.tweetId,
  });
  return {
    success: false,
    message: 'Could not post quote tweet',
    targetTweetId: target.tweetId,
    targetUrl: target.url,
    debug: await getQuoteFlowDebug(pg),
  };
}

// ============================================================================
// 15. Download Video
// ============================================================================

export async function x_download_video({ tweetUrl, url }) {
  tweetUrl = tweetUrl || url;
  const { page: pg } = await ensureBrowser();
  await gotoX(pg, tweetUrl);
  await randomDelay();

  const targetArticle = await findTweetArticleByUrl(pg, tweetUrl);
  const evalScope = targetArticle || pg;
  const videoUrls = await evalScope.evaluate((el) => {
    const root = el?.querySelectorAll ? el : document;
    const videos = [];
    const html = root === document ? document.documentElement.innerHTML : root.innerHTML;
    const patterns = [
      /https:\/\/video\.twimg\.com\/[^"'\s]+\.mp4[^"'\s]*/g,
      /https:\/\/[^"'\s]*\/amplify_video[^"'\s]*\.mp4[^"'\s]*/g,
      /https:\/\/[^"'\s]*\/ext_tw_video[^"'\s]*\.mp4[^"'\s]*/g,
    ];

    patterns.forEach((pattern) => {
      (html.match(pattern) || []).forEach((url) => {
        let clean = url
          .replace(/\\u002F/g, '/')
          .replace(/\\/g, '')
          .split('"')[0]
          .split("'")[0];
        if (clean.includes('.mp4')) {
          const quality = clean.match(/\/(\d+x\d+)\//)?.[1] || 'unknown';
          videos.push({ url: clean, quality });
        }
      });
    });

    const seen = new Set();
    return videos.filter((v) => {
      const key = v.url.split('?')[0];
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

  if (!videoUrls.length) {
    return { success: false, message: 'No video found in tweet' };
  }

  videoUrls.sort((a, b) => {
    const res = (q) => parseInt(q.match(/(\d+)x(\d+)/)?.[2] || '0');
    return res(b.quality) - res(a.quality);
  });

  return {
    success: true,
    videos: videoUrls,
    bestQuality: videoUrls[0],
    message: `Found ${videoUrls.length} video(s)`,
  };
}

// ============================================================================
// 16. Profile Management
// ============================================================================

export async function x_update_profile({ name, bio, location, website }) {
  const { page: pg } = await ensureBrowser();
  await gotoX(pg, 'https://x.com/settings/profile');
  await randomDelay();

  // If redirected to the profile page, open the edit dialog
  const editBtn = await pg.$('[data-testid="editProfileButton"]');
  if (editBtn) {
    await editBtn.click();
    await sleep(1500);
  }

  const fillField = async (selector, value) => {
    if (value === undefined) return;
    const el = await pg.$(selector);
    if (el) {
      await el.click({ clickCount: 3 });
      await el.type(value, { delay: 30 });
    }
  };

  await fillField('input[name="displayName"]', name);
  await fillField('textarea[name="description"]', bio);
  await fillField('input[name="location"]', location);
  await fillField('input[name="url"]', website);

  if (await clickIfPresent(pg, '[data-testid="Profile_Save_Button"]')) {
    await randomDelay();
    return { success: true, message: 'Profile updated' };
  }
  return { success: false, message: 'Could not save profile changes' };
}

// ============================================================================
// 17–20. Posting & Content
// ============================================================================

export async function x_post_thread({ tweets }) {
  if (!tweets || tweets.length < 2) {
    return { success: false, message: 'Thread requires at least 2 tweets' };
  }

  const { page: pg } = await ensureBrowser();
  await gotoX(pg, 'https://x.com/compose/tweet');
  await randomDelay();

  const textbox = await pg.$('[data-testid="tweetTextarea_0"]');
  if (!textbox) return { success: false, message: 'Could not open compose' };
  await textbox.type(tweets[0], { delay: 40 });
  await sleep(500);

  for (let i = 1; i < tweets.length; i++) {
    // Click "Add another tweet" button
    await clickIfPresent(pg, '[data-testid="addButton"]');
    await sleep(500);
    const nextBox = await pg.$(`[data-testid="tweetTextarea_${i}"]`);
    if (nextBox) {
      await nextBox.type(tweets[i], { delay: 40 });
      await sleep(300);
    }
  }

  if (await clickIfPresent(pg, '[data-testid="tweetButton"]')) {
    await randomDelay();
    return { success: true, message: `Thread posted (${tweets.length} tweets)` };
  }
  return { success: false, message: 'Could not post thread' };
}

export async function x_create_poll({ question, options, durationMinutes = 1440 }) {
  if (!options || options.length < 2 || options.length > 4) {
    return { success: false, message: 'Polls require 2–4 options' };
  }

  const { page: pg } = await ensureBrowser();
  await gotoX(pg, 'https://x.com/compose/tweet');
  await randomDelay();

  const textbox = await pg.$('[data-testid="tweetTextarea_0"]');
  if (!textbox) return { success: false, message: 'Could not open compose' };
  await textbox.type(question, { delay: 40 });
  await sleep(500);

  // Open poll UI
  const pollBtn = await pg.$('[data-testid="pollButton"]');
  if (!pollBtn) return { success: false, message: 'Poll button not found (may require Premium)' };
  await pollBtn.click();
  await sleep(1000);

  // Fill poll options (3rd/4th may need "+ Add" click first)
  for (let i = 0; i < options.length; i++) {
    if (i >= 2) {
      await clickIfPresent(pg, '[data-testid="addPollOption"]');
      await sleep(300);
    }
    const input = await pg.$(`[data-testid="pollOption${i + 1}"]`);
    if (input) {
      await input.type(options[i], { delay: 30 });
      await sleep(200);
    }
  }

  if (await clickIfPresent(pg, '[data-testid="tweetButton"]')) {
    await randomDelay();
    return { success: true, message: `Poll posted with ${options.length} options` };
  }
  return { success: false, message: 'Could not post poll' };
}

export async function x_schedule_post({ text, scheduledAt }) {
  const { page: pg } = await ensureBrowser();
  await gotoX(pg, 'https://x.com/compose/tweet');
  await randomDelay();

  const textbox = await pg.$('[data-testid="tweetTextarea_0"]');
  if (!textbox) return { success: false, message: 'Could not open compose' };
  await textbox.type(text, { delay: 40 });
  await sleep(500);

  const schedBtn = await pg.$('[data-testid="scheduleButton"]');
  if (!schedBtn) return { success: false, message: 'Schedule button not found (requires Premium)' };
  await schedBtn.click();
  await sleep(1000);

  // Confirm the scheduling dialog
  if (await clickIfPresent(pg, '[data-testid="scheduledConfirmationPrimaryAction"]')) {
    await sleep(500);
    if (await clickIfPresent(pg, '[data-testid="tweetButton"]')) {
      await randomDelay();
      return { success: true, message: `Tweet scheduled for ${scheduledAt}` };
    }
  }
  return { success: false, message: 'Could not schedule tweet' };
}

export async function x_delete_tweet({ url, tweetUrl }) {
  const target = normalizeTweetTarget({ url, tweetUrl });
  if (!target.tweetId || !target.url) {
    return { success: false, message: 'Invalid tweet URL: expected /status/<id>' };
  }

  const { page: pg } = await ensureBrowser();
  await gotoX(pg, target.url);
  await randomDelay();

  // Open the caret "⋯" menu on the tweet
  const { scope } = await getTweetActionScope(pg, target.url);
  if (!scope) {
    await recoverAfterTweetTargetMiss(pg);
    return { success: false, message: 'Could not find target tweet', targetTweetId: target.tweetId, targetUrl: target.url };
  }

  const caret = await scope.$('[data-testid="caret"]');
  if (caret) {
    await caret.click();
    await sleep(500);
    // Click "Delete" from dropdown
    if (await clickMenuItemByText(pg, /delete/i)) {
      await sleep(500);
      if (await clickIfPresent(pg, '[data-testid="confirmationSheetConfirm"]')) {
        await randomDelay();
        return { success: true, message: 'Tweet deleted' };
      }
    }
  }
  return { success: false, message: 'Could not delete tweet (you may not own this tweet)' };
}

// ============================================================================
// 21–25. Engagement
// ============================================================================

export async function x_reply({ url, tweetUrl, text }) {
  const target = normalizeTweetTarget({ url, tweetUrl });
  if (!target.tweetId || !target.url) {
    return { success: false, message: 'Invalid tweet URL: expected /status/<id>' };
  }

  const { page: pg } = await ensureBrowser();
  const replyScope = await openReplyComposer(pg, {
    url: target.url,
    tweetId: target.tweetId,
    text,
  });
  if (!replyScope) {
    await recoverAfterTweetTargetMiss(pg);
    return { success: false, message: 'Could not open reply composer for target tweet', targetUrl: target.url, targetTweetId: target.tweetId };
  }

  if (await clickTweetButtonInScope(replyScope)) {
    await randomDelay();
    return { success: true, message: 'Reply posted', targetUrl: target.url, targetTweetId: target.tweetId };
  }
  return { success: false, message: 'Could not reply to tweet', targetUrl: target.url, targetTweetId: target.tweetId };
}

export async function x_bookmark({ url, tweetUrl }) {
  const target = normalizeTweetTarget({ url, tweetUrl });
  if (!target.tweetId || !target.url) {
    return { success: false, message: 'Invalid tweet URL: expected /status/<id>' };
  }

  const { page: pg } = await ensureBrowser();
  await gotoX(pg, target.url);
  await randomDelay();

  const { targetArticle, scope } = await getTweetActionScope(pg, target.url);
  if (!scope) {
    await recoverAfterTweetTargetMiss(pg);
    return { success: false, message: 'Could not find target tweet', targetTweetId: target.tweetId, targetUrl: target.url };
  }
  if (targetArticle && await targetArticle.$('[data-testid="removeBookmark"]')) {
    return { success: true, message: 'Tweet already bookmarked', targetTweetId: target.tweetId, targetUrl: target.url };
  }

  const bookmarkButton = await scope.$('[data-testid="bookmark"]');
  if (bookmarkButton) {
    await bookmarkButton.click();
    await randomDelay();
    return { success: true, message: 'Tweet bookmarked', targetTweetId: target.tweetId, targetUrl: target.url };
  }
  return { success: false, message: 'Could not bookmark tweet', targetTweetId: target.tweetId, targetUrl: target.url };
}

export async function x_get_bookmarks({ limit = 100 }) {
  const { page: pg } = await ensureBrowser();
  return scrapeBookmarks(pg, { limit });
}

export async function x_clear_bookmarks() {
  const { page: pg } = await ensureBrowser();
  await gotoX(pg, 'https://x.com/i/bookmarks');
  await randomDelay();

  // Open the ⋯ overflow menu
  if (await clickIfPresent(pg, '[data-testid="caret"], [aria-label="More"]')) {
    await sleep(500);
    if (await clickMenuItemByText(pg, /clear all bookmarks/i)) {
      await sleep(500);
      if (await clickIfPresent(pg, '[data-testid="confirmationSheetConfirm"]')) {
        await randomDelay();
        return { success: true, message: 'All bookmarks cleared' };
      }
    }
  }
  return { success: false, message: 'Could not clear bookmarks' };
}

export async function x_auto_like({ keywords = [], maxLikes = 20 }) {
  const { page: pg } = await ensureBrowser();
  await gotoX(pg, 'https://x.com/home');
  await randomDelay();

  let liked = 0;
  const maxScrolls = maxLikes * 2;

  for (let scroll = 0; scroll < maxScrolls && liked < maxLikes; scroll++) {
    const tweets = await pg.$$('article[data-testid="tweet"]');

    for (const tweet of tweets) {
      if (liked >= maxLikes) break;

      const text = await tweet
        .$eval('[data-testid="tweetText"]', (el) => el.textContent)
        .catch(() => '');
      const matches =
        keywords.length === 0 ||
        keywords.some((kw) => text.toLowerCase().includes(kw.toLowerCase()));

      if (matches) {
        const likeBtn = await tweet.$('[data-testid="like"]');
        if (likeBtn) {
          await likeBtn.click();
          liked++;
          await randomDelay();
        }
      }
    }
    await pg.evaluate(() => window.scrollBy(0, window.innerHeight));
    await sleep(1500);
  }
  return { success: true, liked, message: `Liked ${liked} tweets` };
}

// ============================================================================
// 26–27. Discovery
// ============================================================================

export async function x_get_trends({ category, limit = 30 }) {
  const { page: pg } = await ensureBrowser();
  return scrapeTrending(pg, { limit });
}

export async function x_get_explore({ category, limit = 30 }) {
  const { page: pg } = await ensureBrowser();
  // Explore and trending share the same underlying page data
  return scrapeTrending(pg, { limit });
}

// ============================================================================
// 28–30. Notifications & Muting
// ============================================================================

export async function x_get_notifications({ limit = 100, filter = 'all' }) {
  const { page: pg } = await ensureBrowser();
  const tab = filter === 'mentions' ? 'mentions' : 'all';
  return scrapeNotifications(pg, { limit, tab });
}

export async function x_mute_user({ username }) {
  const { page: pg } = await ensureBrowser();
  await gotoX(pg, `https://x.com/${username}`);
  await randomDelay();

  if (await clickIfPresent(pg, '[data-testid="userActions"]')) {
    await sleep(500);
    if (await clickMenuItemByText(pg, /^mute @/i)) {
      await randomDelay();
      return { success: true, message: `Muted @${username}` };
    }
  }
  return { success: false, message: `Could not mute @${username}` };
}

export async function x_unmute_user({ username }) {
  const { page: pg } = await ensureBrowser();
  await gotoX(pg, `https://x.com/${username}`);
  await randomDelay();

  if (await clickIfPresent(pg, '[data-testid="userActions"]')) {
    await sleep(500);
    if (await clickMenuItemByText(pg, /^unmute @/i)) {
      await randomDelay();
      return { success: true, message: `Unmuted @${username}` };
    }
  }
  return { success: false, message: `Could not unmute @${username}` };
}

// ============================================================================
// 31–33. Direct Messages
// ============================================================================

export async function x_send_dm({ username, message }) {
  const { page: pg } = await ensureBrowser();
  await gotoX(pg, 'https://x.com/messages');
  await randomDelay();

  // Start new conversation
  if (await clickIfPresent(pg, '[data-testid="NewDM_Button"]')) {
    await sleep(1000);
    const search = await pg.$('[data-testid="searchPeople"]');
    if (search) {
      await search.type(username, { delay: 50 });
      await sleep(1500);

      if (await clickIfPresent(pg, '[data-testid="TypeaheadUser"]')) {
        await sleep(500);
        if (await clickIfPresent(pg, '[data-testid="nextButton"]')) {
          await sleep(1000);

          const msgBox = await pg.$('[data-testid="dmComposerTextInput"]');
          if (msgBox) {
            await msgBox.type(message, { delay: 40 });
            await sleep(300);
            if (await clickIfPresent(pg, '[data-testid="dmComposerSendButton"]')) {
              await randomDelay();
              return { success: true, message: `DM sent to @${username}` };
            }
          }
        }
      }
    }
  }
  return { success: false, message: `Could not send DM to @${username}` };
}

export async function x_get_conversations({ limit = 20 }) {
  const { page: pg } = await ensureBrowser();
  await gotoX(pg, 'https://x.com/messages');
  await randomDelay(2000, 3000);

  const conversations = await pg.evaluate((max) => {
    const els = document.querySelectorAll('[data-testid="conversation"]');
    return Array.from(els)
      .slice(0, max)
      .map((el) => {
        const nameEl = el.querySelector('[dir="ltr"] > span');
        const previewEl = el.querySelector('[dir="auto"]');
        const timeEl = el.querySelector('time');
        return {
          name: nameEl?.textContent || null,
          preview: previewEl?.textContent || null,
          time: timeEl?.getAttribute('datetime') || null,
        };
      });
  }, limit);

  return conversations;
}

export async function x_export_dms({ limit = 100 }) {
  const { page: pg } = await ensureBrowser();
  await gotoX(pg, 'https://x.com/messages');
  await randomDelay(2000, 3000);

  const convos = await x_get_conversations({ limit: 10 });
  const allMessages = [];
  const convEls = await pg.$$('[data-testid="conversation"]');
  const toProcess = Math.min(convEls.length, Math.ceil(limit / 10));

  for (let i = 0; i < toProcess; i++) {
    // Re-query because DOM may have changed after navigation
    const currentConvEls = await pg.$$('[data-testid="conversation"]');
    if (!currentConvEls[i]) break;
    await currentConvEls[i].click();
    await sleep(2000);

    const messages = await pg.evaluate(() => {
      const msgEls = document.querySelectorAll('[data-testid="messageEntry"]');
      return Array.from(msgEls).map((msg) => {
        const text =
          msg.querySelector('[data-testid="tweetText"]')?.textContent ||
          msg.innerText?.slice(0, 500);
        const time = msg.querySelector('time')?.getAttribute('datetime');
        return { text, time };
      });
    });

    allMessages.push({
      conversation: convos[i]?.name || `Conversation ${i + 1}`,
      messages,
    });

    await clickIfPresent(pg, '[data-testid="app-bar-back"]');
    await sleep(1000);
  }

  return {
    conversations: allMessages,
    total: allMessages.reduce((sum, c) => sum + c.messages.length, 0),
  };
}

// ============================================================================
// 34–35. Grok AI
// ============================================================================

export async function x_grok_query({ query, mode = 'default' }) {
  const { page: pg } = await ensureBrowser();
  await gotoX(pg, 'https://x.com/i/grok');
  await randomDelay(2000, 3000);

  // Find input
  const input = await pg.$(
    '[data-testid="grokTextArea"], textarea, [contenteditable="true"]'
  );
  if (!input) {
    return { success: false, message: 'Grok interface not found (requires Premium)' };
  }

  await input.type(query, { delay: 40 });
  await sleep(500);

  // Select mode if not default
  if (mode !== 'default') {
    const modeMap = { deepsearch: 'DeepSearch', think: 'Think' };
    const target = modeMap[mode];
    if (target) {
      const modeBtn = await pg.$(`[data-testid="grok${target}Button"]`);
      if (modeBtn) await modeBtn.click();
      await sleep(500);
    }
  }

  // Submit
  const sendBtn = await pg.$(
    '[data-testid="grokSendButton"], button[type="submit"]'
  );
  if (sendBtn) {
    await sendBtn.click();
    // Wait for response — longer for DeepSearch
    await sleep(mode === 'deepsearch' ? 15000 : 5000);

    const response = await pg.evaluate(() => {
      const blocks = document.querySelectorAll(
        '[data-testid="grokResponse"], [class*="response"]'
      );
      const last = blocks[blocks.length - 1];
      return last?.textContent || null;
    });

    if (response) {
      return { success: true, response, mode };
    }
  }
  return { success: false, message: 'Could not get Grok response' };
}

export async function x_grok_summarize({ topic }) {
  return x_grok_query({
    query: `Summarize what people on X/Twitter are saying about: ${topic}`,
    mode: 'default',
  });
}

// ============================================================================
// 36–37. Lists
// ============================================================================

export async function x_get_lists({ limit = 50 }) {
  const { page: pg } = await ensureBrowser();
  await gotoX(pg, 'https://x.com/i/lists');
  await randomDelay();

  const lists = await pg.evaluate((max) => {
    const els = document.querySelectorAll('a[href*="/i/lists/"]');
    return Array.from(els)
      .slice(0, max)
      .map((el) => {
        const nameEl = el.querySelector('span');
        return { name: nameEl?.textContent || null, url: el.href || null };
      })
      .filter((l) => l.name);
  }, limit);

  return lists;
}

export async function x_get_list_members({ listUrl, limit = 100 }) {
  const { page: pg } = await ensureBrowser();
  return scrapeListMembers(pg, listUrl, { limit });
}

// ============================================================================
// 38–39. Spaces
// ============================================================================

export async function x_get_spaces({ filter = 'live', topic, limit = 20 }) {
  const { page: pg } = await ensureBrowser();
  const query = topic || 'twitter spaces';
  return scrapeSpaces(pg, query, { limit });
}

export async function x_scrape_space({ url }) {
  const { page: pg } = await ensureBrowser();
  await gotoX(pg, url);
  await randomDelay(3000, 5000);

  const space = await pg.evaluate(() => {
    const getText = (sel) => document.querySelector(sel)?.textContent?.trim() || null;
    const title =
      getText('[data-testid="SpaceTitle"]') || getText('h1') || getText('h2');
    const host = getText('[data-testid="SpaceHost"]');
    const listeners = getText('[data-testid="SpaceListenerCount"]');
    const state = getText('[data-testid="SpaceState"]') || 'unknown';

    const speakers = Array.from(
      document.querySelectorAll('[data-testid="SpaceSpeaker"]')
    ).map((el) => ({
      name: el.querySelector('span')?.textContent || null,
    }));

    return { title, host, listeners, speakers, state };
  });

  return { success: true, ...space, url };
}

// ============================================================================
// 40–41. Analytics
// ============================================================================

export async function x_get_analytics({ period = '28d' }) {
  const { page: pg } = await ensureBrowser();
  await gotoX(pg, 'https://x.com/i/account_analytics');
  await randomDelay(2000, 3000);

  const analytics = await pg.evaluate(() => {
    const metrics = {};
    const statEls = document.querySelectorAll(
      '[data-testid="analyticsMetric"], [class*="metric"]'
    );
    statEls.forEach((el) => {
      const label = el.querySelector('[class*="label"], small')?.textContent;
      const value = el.querySelector(
        '[class*="value"], strong, span:first-child'
      )?.textContent;
      if (label && value) metrics[label.trim()] = value.trim();
    });

    // Fallback: regex extract from page text
    if (!Object.keys(metrics).length) {
      const text = document.body.innerText;
      const extract = (pattern) => text.match(pattern)?.[1] || null;
      const impressions = extract(/impressions[:\s]+([\d,.KMB]+)/i);
      const engagements = extract(/engagements[:\s]+([\d,.KMB]+)/i);
      const followers = extract(/followers[:\s]+([\d,.KMB]+)/i);
      if (impressions) metrics.impressions = impressions;
      if (engagements) metrics.engagements = engagements;
      if (followers) metrics.followers = followers;
    }

    return metrics;
  });

  return { period, analytics };
}

export async function x_get_post_analytics({ url, tweetUrl }) {
  const target = normalizeTweetTarget({ url, tweetUrl });
  if (!target.tweetId || !target.url) {
    return { success: false, message: 'Invalid tweet URL: expected /status/<id>' };
  }

  const { page: pg } = await ensureBrowser();
  await gotoX(pg, target.url);
  await randomDelay();

  const targetArticle = await waitForTweetArticleById(pg, target.tweetId);
  if (!targetArticle) {
    await recoverAfterTweetTargetMiss(pg);
    return { success: false, message: 'Could not find target tweet', targetTweetId: target.tweetId, targetUrl: target.url };
  }

  const analytics = await targetArticle.evaluate((el) => {
    const article = el?.matches?.('article[data-testid="tweet"]')
      ? el
      : document.querySelector('article[data-testid="tweet"]');
    if (!article) return null;
    const stat = (testid) =>
      article.querySelector(`[data-testid="${testid}"] span span`)?.textContent || '0';

    return {
      text:
        article.querySelector('[data-testid="tweetText"]')?.textContent || '',
      likes: stat('like'),
      retweets: stat('retweet'),
      replies: stat('reply'),
      views:
        article.querySelector('a[href*="/analytics"] span span')?.textContent ||
        null,
      bookmarks: stat('bookmark'),
    };
  });

  if (!analytics) return { success: false, message: 'Could not find tweet' };
  return { success: true, url: target.url, targetTweetId: target.tweetId, ...analytics };
}

// ============================================================================
// 42–44. Settings & Blocked
// ============================================================================

export async function x_get_settings() {
  const { page: pg } = await ensureBrowser();
  await gotoX(pg, 'https://x.com/settings/account');
  await randomDelay();

  return pg.evaluate(() => {
    const items = {};
    document.querySelectorAll('a[href*="/settings/"]').forEach((link) => {
      const label = link.querySelector('span')?.textContent;
      const value = link.querySelector('[dir="ltr"]')?.textContent;
      if (label) items[label.trim()] = value?.trim() || 'configured';
    });
    return items;
  });
}

export async function x_toggle_protected({ enabled }) {
  const { page: pg } = await ensureBrowser();
  await gotoX(pg, 'https://x.com/settings/audience_and_tagging');
  await randomDelay();

  const checkbox = await pg.$('input[type="checkbox"]');
  if (checkbox) {
    const isChecked = await checkbox.evaluate((el) => el.checked);
    if ((enabled && !isChecked) || (!enabled && isChecked)) {
      await checkbox.click();
      await sleep(500);
      await clickIfPresent(pg, '[data-testid="confirmationSheetConfirm"]');
      await randomDelay();
      return {
        success: true,
        protected: enabled,
        message: `Account ${enabled ? 'protected' : 'set to public'}`,
      };
    }
    return {
      success: true,
      protected: enabled,
      message: `Already ${enabled ? 'protected' : 'public'}`,
    };
  }
  return { success: false, message: 'Could not find protect toggle' };
}

export async function x_get_blocked({ limit = 200 }) {
  const { page: pg } = await ensureBrowser();
  await gotoX(pg, 'https://x.com/settings/blocked/all');
  await randomDelay();

  return scrollCollect(
    pg,
    () => {
      const cells = document.querySelectorAll('[data-testid="UserCell"]');
      return Array.from(cells)
        .map((cell) => {
          const link = cell.querySelector('a[href^="/"]');
          const nameEl = cell.querySelector('[dir="ltr"] > span');
          const username =
            link?.getAttribute('href')?.split('/')[1] || null;
          return {
            _key: username,
            username,
            name: nameEl?.textContent || null,
          };
        })
        .filter((u) => u.username);
    },
    { limit }
  );
}

// ============================================================================
// 45–46. Business
// ============================================================================

export async function x_brand_monitor({ brand, limit = 50, sentiment = true }) {
  const { page: pg } = await ensureBrowser();
  const tweets = await searchTweets(pg, brand, { limit });

  if (!sentiment) {
    return { brand, mentions: tweets, count: tweets.length };
  }

  // Simple keyword-based sentiment classification
  const posWords = [
    'love', 'great', 'amazing', 'best', 'awesome', 'excellent', 'good', 'fantastic',
  ];
  const negWords = [
    'hate', 'awful', 'terrible', 'worst', 'bad', 'horrible', 'poor', 'disappointing',
  ];

  const analyzed = tweets.map((tweet) => {
    const text = (tweet.text || '').toLowerCase();
    const pos = posWords.filter((w) => text.includes(w)).length;
    const neg = negWords.filter((w) => text.includes(w)).length;
    const label = pos > neg ? 'positive' : neg > pos ? 'negative' : 'neutral';
    return { ...tweet, sentiment: label };
  });

  const summary = {
    positive: analyzed.filter((t) => t.sentiment === 'positive').length,
    neutral: analyzed.filter((t) => t.sentiment === 'neutral').length,
    negative: analyzed.filter((t) => t.sentiment === 'negative').length,
  };

  return { brand, mentions: analyzed, count: analyzed.length, sentiment: summary };
}

export async function x_competitor_analysis({ handles }) {
  if (!handles || handles.length < 2) {
    return { success: false, message: 'Provide at least 2 handles to compare' };
  }

  const { page: pg } = await ensureBrowser();
  const profiles = [];
  for (const handle of handles) {
    const profile = await scrapeProfile(pg, handle.replace('@', ''));
    profiles.push(profile);
    await sleep(1000);
  }

  return {
    accounts: profiles,
    comparison: profiles.map((p) => ({
      username: p.username,
      followers: p.followers,
      following: p.following,
      tweetCount: p.tweetCount || p.tweets,
    })),
  };
}

// ============================================================================
// 47. Premium
// ============================================================================

export async function x_check_premium() {
  const { page: pg } = await ensureBrowser();
  await gotoX(pg, 'https://x.com/settings/your_twitter_data/account');
  await randomDelay();

  return pg.evaluate(() => {
    const text = document.body.innerText;
    const isPremium = /premium|blue|verified|subscriber/i.test(text);
    const tier =
      text.match(/(basic|premium\s*\+?|premium\s*plus)/i)?.[1] || null;
    return { isPremium, tier };
  });
}

// ============================================================================
// 48. Articles
// ============================================================================

export async function x_publish_article({ title, body, publish = false }) {
  const { page: pg } = await ensureBrowser();
  await gotoX(pg, 'https://x.com/i/articles/new');
  await randomDelay(2000, 3000);

  const titleEl = await pg.$(
    '[data-testid="articleTitle"], [contenteditable="true"]:first-child, input[placeholder*="Title"]'
  );
  if (!titleEl) {
    return { success: false, message: 'Article editor not found (requires Premium+)' };
  }
  await titleEl.type(title, { delay: 30 });
  await sleep(500);

  const bodyEl = await pg.$(
    '[data-testid="articleBody"], [contenteditable="true"]:last-child'
  );
  if (bodyEl) {
    await bodyEl.type(body, { delay: 20 });
    await sleep(500);
  }

  if (publish) {
    if (await clickIfPresent(pg, '[data-testid="publishButton"]')) {
      await randomDelay();
      return { success: true, message: 'Article published' };
    }
  } else {
    if (await clickIfPresent(pg, '[data-testid="saveDraftButton"]')) {
      await randomDelay();
      return { success: true, message: 'Article saved as draft' };
    }
  }
  return { success: false, message: 'Could not save article' };
}

// ============================================================================
// 49. Creator Analytics
// ============================================================================

export async function x_creator_analytics({ period = '28d' }) {
  const { page: pg } = await ensureBrowser();
  await gotoX(pg, 'https://x.com/i/monetization');
  await randomDelay(2000, 3000);

  return pg.evaluate(() => {
    const metrics = {};
    const text = document.body.innerText;
    const extract = (pattern) => text.match(pattern)?.[1] || null;

    const revenue = extract(/revenue[:\s]*\$?([\d,.]+)/i);
    const subscribers = extract(/subscribers[:\s]*([\d,.]+)/i);
    const views = extract(/views[:\s]*([\d,.KMB]+)/i);

    if (revenue) metrics.revenue = revenue;
    if (subscribers) metrics.subscribers = subscribers;
    if (views) metrics.views = views;

    return metrics;
  });
}

// ============================================================================
// HTTP Client Tools (no Puppeteer — faster, lightweight)
// ============================================================================

import { Scraper, SearchMode } from '../client/index.js';

/**
 * Helper: create a Scraper instance with saved cookies if available.
 */
async function getClientScraper() {
  const scraper = new Scraper();
  const cookiePath = path.join(os.homedir(), '.xactions', 'cookies.json');
  try {
    await fs.access(cookiePath);
    await scraper.loadCookies(cookiePath);
  } catch {
    // No saved cookies — will use guest token for read-only operations
  }
  return scraper;
}

/** Get a user's profile using the HTTP client (no browser needed). */
export async function x_client_get_profile({ username }) {
  const scraper = await getClientScraper();
  return scraper.getProfile(username);
}

/** Get a single tweet by ID using the HTTP client. */
export async function x_client_get_tweet({ tweetId }) {
  const scraper = await getClientScraper();
  return scraper.getTweet(tweetId);
}

/** Search tweets using the HTTP client. */
export async function x_client_search({ query, count = 20, mode = 'Latest' }) {
  const scraper = await getClientScraper();
  const results = [];
  for await (const tweet of scraper.searchTweets(query, count, mode)) {
    results.push(tweet);
  }
  return results;
}

/** Post a tweet using the HTTP client (requires saved auth cookies). */
export async function x_client_send_tweet({ text }) {
  const scraper = await getClientScraper();
  return scraper.sendTweet(text);
}

/** Get a user's followers using the HTTP client. */
export async function x_client_get_followers({ username, count = 100 }) {
  const scraper = await getClientScraper();
  const profile = await scraper.getProfile(username);
  const followers = [];
  for await (const follower of scraper.getFollowers(profile.id, count)) {
    followers.push(follower);
  }
  return followers;
}

/** Get trending topics using the HTTP client. */
export async function x_client_get_trends() {
  const scraper = await getClientScraper();
  return scraper.getTrends();
}

// ============================================================================
// Cross-Platform Scraping Tools
// ============================================================================

export async function x_get_profile_multiplatform({ username, platform = 'twitter', instance }) {
  if (platform === 'twitter' || platform === 'x') {
    return x_get_profile({ username });
  }

  return scrape(platform, 'profile', { username, instance });
}

export async function x_get_followers_multiplatform({ username, platform = 'twitter', limit = 100, instance }) {
  if (platform === 'twitter' || platform === 'x') {
    return x_get_followers({ username, limit });
  }

  return scrape(platform, 'followers', { username, limit, instance });
}

export async function x_get_following_multiplatform({ username, platform = 'twitter', limit = 100, instance }) {
  if (platform === 'twitter' || platform === 'x') {
    return x_get_following({ username, limit });
  }

  return scrape(platform, 'following', { username, limit, instance });
}

export async function x_get_tweets_multiplatform({ username, platform = 'twitter', limit = 50, instance }) {
  if (platform === 'twitter' || platform === 'x') {
    return x_get_tweets({ username, limit });
  }

  return scrape(platform, 'tweets', { username, limit, instance });
}

export async function x_search_tweets_multiplatform({ query, platform = 'twitter', limit = 50, instance }) {
  if (platform === 'twitter' || platform === 'x') {
    return x_search_tweets({ query, limit });
  }

  return scrape(platform, 'search', { query, limit, instance });
}

export async function x_list_platforms() {
  return {
    platforms: [
      { name: 'twitter', aliases: ['x'], description: 'X/Twitter - Puppeteer-based scraping', requiresAuth: true },
      { name: 'bluesky', aliases: ['bsky'], description: 'Bluesky - AT Protocol API', requiresAuth: false },
      { name: 'mastodon', aliases: ['masto'], description: 'Mastodon - REST API for any instance', requiresAuth: false },
      { name: 'threads', aliases: [], description: 'Threads - Puppeteer-based scraping', requiresAuth: false },
    ],
  };
}

// ============================================================================
// Tool Map — all tools matching server.js TOOLS (excluding streaming)
// ============================================================================

export const toolMap = {
  getPage,
  // Auth
  x_login,
  // Scraping (delegated to scrapers/index.js — single source of truth)
  x_get_profile,
  x_get_followers,
  x_get_following,
  x_get_non_followers,
  x_get_tweets,
  x_search_tweets,
  x_get_thread,
  x_best_time_to_post,
  // Core actions
  x_follow,
  x_unfollow,
  // Bulk
  x_unfollow_non_followers,
  x_detect_unfollowers,
  // Post / Like / Retweet
  x_post_tweet,
  x_like,
  x_retweet,
  x_quote_tweet,
  x_download_video,
  // Profile management
  x_update_profile,
  // Posting & content
  x_post_thread,
  x_create_poll,
  x_schedule_post,
  x_delete_tweet,
  // Engagement
  x_reply,
  x_bookmark,
  x_get_bookmarks,
  x_clear_bookmarks,
  x_auto_like,
  // Discovery
  x_get_trends,
  x_get_explore,
  // Notifications
  x_get_notifications,
  x_mute_user,
  x_unmute_user,
  // Direct messages
  x_send_dm,
  x_get_conversations,
  x_export_dms,
  // Grok AI
  x_grok_query,
  x_grok_summarize,
  // Lists
  x_get_lists,
  x_get_list_members,
  // Spaces
  x_get_spaces,
  x_scrape_space,
  // Analytics
  x_get_analytics,
  x_get_post_analytics,
  // Settings
  x_get_settings,
  x_toggle_protected,
  x_get_blocked,
  // Business
  x_brand_monitor,
  x_competitor_analysis,
  // Premium / Creator
  x_check_premium,
  x_publish_article,
  x_creator_analytics,
  // ── HTTP Client Tools (no Puppeteer — faster) ───────────────────────────
  x_client_get_profile,
  x_client_get_tweet,
  x_client_search,
  x_client_send_tweet,
  x_client_get_followers,
  x_client_get_trends,
  // Cross-platform
  x_get_profile_multiplatform,
  x_get_followers_multiplatform,
  x_get_following_multiplatform,
  x_get_tweets_multiplatform,
  x_search_tweets_multiplatform,
  x_list_platforms,
  // Utility (not an MCP tool, used by server.js cleanup)
  closeBrowser,
};

export default toolMap;
