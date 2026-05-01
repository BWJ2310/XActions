// Copyright (c) 2024-2026 nich (@nichxbt). Business Source License 1.1.
/**
 * MCP Server — Tool Definition Tests
 *
 * Tests the TOOLS array structure without starting the stdio transport.
 * Follows the same no-mock pattern as the rest of the test suite.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

// We need to stub the stdio transport before importing the server so it
// doesn't block on stdin. Use a lightweight import-time trick: set an env
// var that the server checks, or intercept the module. Since the project
// uses Vitest, we rely on its ESM mock support via importMock / vi.mock.
// For now we import TOOLS directly — the server guards main() behind an
// explicit call so importing it is safe.

let TOOLS;

async function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function waitForServer(url, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`Unexpected status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw lastError || new Error(`Timed out waiting for ${url}`);
}

describe('MCP HTTP transport', () => {
  let child;
  let baseUrl;
  const bearerToken = 'test-bearer-token';

  before(async () => {
    const port = await getAvailablePort();
    baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['src/mcp/server.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MCP_TRANSPORT: 'http',
        MCP_HOST: '127.0.0.1',
        PORT: String(port),
        XACTIONS_MODE: 'local',
        XACTIONS_PREWARM_BROWSER: 'false',
        XACTIONS_BROWSER_IDLE_MS: '0',
        XACTIONS_SERIALIZE_LOCAL_TOOLS: 'true',
        XACTIONS_MCP_BEARER_TOKEN: bearerToken,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await waitForServer(`${baseUrl}/health`);
  });

  after(async () => {
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  });

  it('returns JSON-RPC bodies for initialize and tools/list over HTTP POST', async () => {
    const headers = {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${bearerToken}`,
      'content-type': 'application/json',
    };

    const initializeResponse = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'server-test', version: '1.0.0' },
        },
      }),
    });

    assert.equal(initializeResponse.status, 200);
    assert.match(initializeResponse.headers.get('content-type') || '', /application\/json/i);

    const sessionId = initializeResponse.headers.get('mcp-session-id');
    assert.ok(sessionId, 'initialize should return a session id');

    const initializeBody = await initializeResponse.json();
    assert.equal(initializeBody.jsonrpc, '2.0');
    assert.equal(initializeBody.id, 1);
    assert.equal(initializeBody.result?.protocolVersion, '2025-03-26');

    const listResponse = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        ...headers,
        'mcp-protocol-version': '2025-03-26',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
    });

    assert.equal(listResponse.status, 200);
    assert.match(listResponse.headers.get('content-type') || '', /application\/json/i);

    const listBody = await listResponse.json();
    assert.equal(listBody.jsonrpc, '2.0');
    assert.equal(listBody.id, 2);
    assert.ok(Array.isArray(listBody.result?.tools));
    assert.ok(listBody.result.tools.length > 0, 'tools/list should return at least one tool');
  });
});

describe('MCP Tool Definitions', () => {
  before(async () => {
    // Dynamically import so vitest has time to apply any setup
    const mod = await import('../../src/mcp/server.js');
    TOOLS = mod.TOOLS;
  });

  it('exports a TOOLS array', () => {
    assert.ok(Array.isArray(TOOLS), 'TOOLS should be an array');
    assert.ok(TOOLS.length > 0, 'TOOLS should not be empty');
  });

  it('every tool has name, description, and inputSchema', () => {
    for (const tool of TOOLS) {
      assert.equal(typeof tool.name, 'string', `${tool.name}: name must be string`);
      assert.ok(tool.name.length > 0, 'name must not be empty');
      assert.equal(typeof tool.description, 'string', `${tool.name}: description must be string`);
      assert.ok(tool.description.length > 0, `${tool.name}: description must not be empty`);
      assert.ok(tool.inputSchema, `${tool.name}: inputSchema is required`);
      assert.equal(tool.inputSchema.type, 'object', `${tool.name}: inputSchema.type must be 'object'`);
    }
  });

  it('all tool names follow x_ prefix convention', () => {
    const nonConforming = TOOLS.filter(t => !t.name.startsWith('x_'));
    assert.equal(
      nonConforming.length,
      0,
      `Non-conforming tool names: ${nonConforming.map(t => t.name).join(', ')}`
    );
  });

  it('tool names are unique', () => {
    const names = TOOLS.map(t => t.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    assert.equal(dupes.length, 0, `Duplicate tool names: ${dupes.join(', ')}`);
  });

  it('x_get_profile requires username', () => {
    const tool = TOOLS.find(t => t.name === 'x_get_profile');
    assert.ok(tool, 'x_get_profile must be defined');
    assert.ok(
      tool.inputSchema.required?.includes('username'),
      'x_get_profile must require username'
    );
  });

  it('x_post_tweet requires text', () => {
    const tool = TOOLS.find(t => t.name === 'x_post_tweet');
    assert.ok(tool, 'x_post_tweet must be defined');
    assert.ok(
      tool.inputSchema.required?.includes('text'),
      'x_post_tweet must require text'
    );
  });

  it('required fields are declared in properties', () => {
    for (const tool of TOOLS) {
      const required = tool.inputSchema.required || [];
      const properties = tool.inputSchema.properties || {};
      for (const field of required) {
        assert.ok(
          properties[field],
          `${tool.name}: required field "${field}" not in properties`
        );
      }
    }
  });
});
