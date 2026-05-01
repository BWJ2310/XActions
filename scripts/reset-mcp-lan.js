#!/usr/bin/env node
// Reset XActions LAN MCP state: stop old MCP processes and clear the shared browser profile.

import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';

const cwd = process.cwd();
const envPath = process.env.XACTIONS_MCP_ENV || path.resolve(cwd, '.env.mcp');

if (existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const userDataDir =
  process.env.XACTIONS_PUPPETEER_USER_DATA_DIR ||
  path.join(os.tmpdir(), 'xactions-puppeteer-profile');

function listLanMcpProcesses() {
  let output = '';
  try {
    output = execFileSync('ps', ['-eo', 'pid=,args='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const firstSpace = line.indexOf(' ');
      const pid = Number.parseInt(firstSpace === -1 ? line : line.slice(0, firstSpace), 10);
      const command = firstSpace === -1 ? '' : line.slice(firstSpace + 1);
      return { pid, command };
    })
    .filter(({ pid, command }) => (
      Number.isFinite(pid) &&
      pid !== process.pid &&
      (
        command.includes('scripts/start-mcp-lan.js') ||
        command.includes('src/mcp/server.js')
      )
    ))
    .sort((a, b) => {
      const aIsServer = a.command.includes('src/mcp/server.js');
      const bIsServer = b.command.includes('src/mcp/server.js');
      if (aIsServer === bIsServer) return a.pid - b.pid;
      return aIsServer ? -1 : 1;
    });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function terminateProcess(pid) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(100);
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(50);
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
  }

  return false;
}

async function main() {
  const processes = listLanMcpProcesses();

  if (processes.length === 0) {
    console.log('No running XActions LAN MCP processes found.');
  } else {
    for (const { pid, command } of processes) {
      const stopped = await terminateProcess(pid);
      console.log(`${stopped ? 'Stopped' : 'Failed to stop'} PID ${pid}: ${command}`);
    }
  }

  if (existsSync(userDataDir)) {
    rmSync(userDataDir, { recursive: true, force: true });
    console.log(`Removed browser profile cache: ${userDataDir}`);
  } else {
    console.log(`Browser profile cache not present: ${userDataDir}`);
  }
}

main().catch((error) => {
  console.error('Failed to reset LAN MCP state:', error.message);
  process.exit(1);
});
