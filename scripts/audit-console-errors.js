#!/usr/bin/env node
// Audit all dashboard pages for browser console errors
// Usage: node scripts/audit-console-errors.js [--verbose] [--port 3001]
// by nichxbt

import puppeteer from 'puppeteer';
import { readdir, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = join(__dirname, '..', 'dashboard');

const args = process.argv.slice(2);
const port = args.includes('--port') ? args[args.indexOf('--port') + 1] : '3001';
const BASE_URL = `http://localhost:${port}`;
const verbose = args.includes('--verbose');
const CONCURRENCY = 3; // pages in parallel

// Errors that are expected / not fixable without running optional services
const IGNORE_PATTERNS = [
  /SES Removing unpermitted intrinsics/,
  /Download error or resource isn't a valid image/,
  // socket.io not running in dev — expected
  /socket\.io/,
  // a2a server (port 3100) is an optional separate service
  /localhost:3100/,
  // auth-gated pages will always have these in dev
  /401/,
];

function isIgnored(text) {
  return IGNORE_PATTERNS.some((p) => p.test(text));
}

async function discoverPages() {
  const pages = [];

  async function walkDir(dir) {
    const entries = await readdir(join(DASHBOARD_DIR, dir), { withFileTypes: true });
    for (const entry of entries) {
      const relPath = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walkDir(relPath);
      } else if (entry.name.endsWith('.html')) {
        pages.push(relPath === 'index.html' ? '/' : `/${relPath}`);
      }
    }
  }

  await walkDir('');
  return [...new Set(pages)].sort();
}

async function auditPage(browser, route) {
  const url = `${BASE_URL}${route}`;
  const issues = { errors: [], warnings: [], networkErrors: [] };

  const page = await browser.newPage();

  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    if (isIgnored(text)) return;
    if (type === 'error') issues.errors.push(text);
    else if (type === 'warning') issues.warnings.push(text);
  });

  page.on('requestfailed', (req) => {
    const reqUrl = req.url();
    if (isIgnored(reqUrl)) return;
    const failure = req.failure();
    issues.networkErrors.push({ url: reqUrl, reason: failure?.errorText ?? 'unknown' });
  });

  page.on('response', (res) => {
    const status = res.status();
    const resUrl = res.url();
    if (status < 400) return;
    if (resUrl.includes('favicon')) return;
    if (isIgnored(resUrl)) return;
    issues.networkErrors.push({ url: resUrl, reason: `HTTP ${status}` });
  });

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 12000 });
    await new Promise((r) => setTimeout(r, 300));
  } catch (e) {
    // Ignore Puppeteer-internal frame lifecycle errors — not real page errors
    const msg = e.message;
    if (
      msg.includes('detached Frame') ||
      msg.includes('detached frame') ||
      msg.includes('Session closed') ||
      msg.includes('Navigation timeout')
    ) {
      // Navigation timeout on networkidle2 is often just slow resources — not a real error
    } else {
      issues.errors.push(`Navigation failed: ${msg}`);
    }
  }

  await page.close().catch(() => {});
  return issues;
}

async function runBatch(browser, routes, results, counters) {
  for (let i = 0; i < routes.length; i += CONCURRENCY) {
    const batch = routes.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map((r) => auditPage(browser, r)));

    for (let j = 0; j < batch.length; j++) {
      const route = batch[j];
      const result = settled[j];

      let issues = { errors: [], warnings: [], networkErrors: [] };
      if (result.status === 'fulfilled') {
        issues = result.value;
      } else {
        issues.errors.push(`Audit crashed: ${result.reason?.message}`);
      }

      const hasIssues = issues.errors.length || issues.warnings.length || issues.networkErrors.length;

      if (hasIssues) {
        counters.withIssues++;
        console.log(`❌ ${route}`);
        for (const err of issues.errors) {
          console.log(`   🔴 ${err}`);
          results.errors.push({ page: route, message: err });
        }
        for (const warn of issues.warnings) {
          console.log(`   🟡 ${warn}`);
          results.warnings.push({ page: route, message: warn });
        }
        for (const net of issues.networkErrors) {
          console.log(`   🟠 ${net.reason} → ${net.url}`);
          results.networkErrors.push({ page: route, ...net });
        }
      } else {
        counters.clean++;
        if (verbose) console.log(`✅ ${route}`);
      }
    }
  }
}

async function auditPages() {
  console.log(`\n⚡ XActions Console Error Audit`);
  console.log(`  Base URL: ${BASE_URL}\n`);

  try {
    const res = await fetch(BASE_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    console.error(`❌ Cannot reach ${BASE_URL} — start the server first: npm run dev`);
    process.exit(1);
  }

  const pages = await discoverPages();
  console.log(`📄 Found ${pages.length} pages to audit (concurrency: ${CONCURRENCY})\n`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    protocolTimeout: 30000,
  });

  const results = { errors: [], warnings: [], networkErrors: [] };
  const counters = { clean: 0, withIssues: 0 };

  try {
    await runBatch(browser, pages, results, counters);
  } finally {
    await browser.close();
  }

  // Summary
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`📊 Audit Summary`);
  console.log(`   Pages scanned:      ${pages.length}`);
  console.log(`   Clean:              ${counters.clean}`);
  console.log(`   With issues:        ${counters.withIssues}`);
  console.log(`   Console errors:     ${results.errors.length}`);
  console.log(`   Console warnings:   ${results.warnings.length}`);
  console.log(`   Network errors:     ${results.networkErrors.length}`);
  console.log(`${'─'.repeat(60)}\n`);

  if (results.errors.length || results.networkErrors.length) {
    console.log(`🔍 Unique Issues:\n`);

    const uniqueErrors = [...new Set(results.errors.map((e) => e.message))];
    if (uniqueErrors.length) {
      console.log(`  Console Errors (${uniqueErrors.length} unique):`);
      for (const err of uniqueErrors) {
        const pages = results.errors.filter((e) => e.message === err).map((e) => e.page);
        console.log(`    [${pages.length}x] ${err}`);
        const show = pages.slice(0, 3);
        for (const p of show) console.log(`         → ${p}`);
        if (pages.length > 3) console.log(`         ... +${pages.length - 3} more`);
      }
    }

    const netByResource = new Map();
    for (const ne of results.networkErrors) {
      const key = `${ne.reason} → ${ne.url.split('?')[0]}`;
      if (!netByResource.has(key)) netByResource.set(key, []);
      netByResource.get(key).push(ne.page);
    }
    if (netByResource.size) {
      console.log(`\n  Network Errors (${netByResource.size} unique resources):`);
      for (const [key, pages] of netByResource) {
        console.log(`    [${pages.length}x] ${key}`);
        const show = pages.slice(0, 2);
        for (const p of show) console.log(`         → ${p}`);
        if (pages.length > 2) console.log(`         ... +${pages.length - 2} more`);
      }
    }
  }

  const reportPath = join(__dirname, '..', 'audit-report.json');
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        baseUrl: BASE_URL,
        pagesScanned: pages.length,
        pagesClean: counters.clean,
        pagesWithIssues: counters.withIssues,
        errors: results.errors,
        warnings: results.warnings,
        networkErrors: results.networkErrors,
      },
      null,
      2
    )
  );
  console.log(`\n📁 Full report saved to audit-report.json`);

  process.exit(counters.withIssues > 0 ? 1 : 0);
}

auditPages().catch((err) => {
  console.error('❌ Audit failed:', err.message);
  process.exit(1);
});
