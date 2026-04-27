#!/usr/bin/env node
// Start the XActions MCP server as a LAN HTTP service using .env.mcp.

import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

const envPath = process.env.XACTIONS_MCP_ENV || path.resolve(process.cwd(), '.env.mcp');

if (!existsSync(envPath)) {
  console.error(`Missing ${envPath}`);
  console.error('Create it with: cp .env.mcp.example .env.mcp');
  process.exit(1);
}

dotenv.config({ path: envPath });

const defaults = {
  MCP_TRANSPORT: 'http',
  MCP_HOST: '0.0.0.0',
  PORT: '3344',
  XACTIONS_MODE: 'local',
  XACTIONS_SERIALIZE_LOCAL_TOOLS: 'true',
  XACTIONS_BROWSER_IDLE_MS: '900000',
};

for (const [key, value] of Object.entries(defaults)) {
  if (!process.env[key]) process.env[key] = value;
}

function firstExecutable(paths) {
  for (const candidate of paths) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

if (!process.env.PUPPETEER_EXECUTABLE_PATH && process.platform === 'linux') {
  const chromium = firstExecutable([
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/opt/google/chrome/chrome',
  ]);

  if (chromium) {
    process.env.PUPPETEER_EXECUTABLE_PATH = chromium;
    console.error(`Using system Chromium for Puppeteer: ${chromium}`);
  } else if (process.arch === 'arm64' || process.arch === 'arm') {
    console.error(
      'No system Chromium found. Linux ARM hosts usually need Chromium installed ' +
      'and PUPPETEER_EXECUTABLE_PATH set, for example /usr/bin/chromium.',
    );
  }
}

const missing = ['XACTIONS_MCP_BEARER_TOKEN', 'XACTIONS_SESSION_COOKIE']
  .filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error(`Missing required value(s) in ${envPath}: ${missing.join(', ')}`);
  process.exit(1);
}

console.error(
  `Starting XActions MCP LAN service at http://${process.env.MCP_HOST}:${process.env.PORT}/mcp`,
);

const child = spawn(process.execPath, ['src/mcp/server.js'], {
  stdio: 'inherit',
  env: process.env,
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
