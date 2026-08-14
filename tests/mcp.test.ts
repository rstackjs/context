import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, test } from '@rstest/core';
import pkgJson from '../package.json' with { type: 'json' };
import { createContextMcpServer } from '../src/mcp.ts';

const toolNames = [
  'project_status',
  'product_roots',
  'unused_candidates',
  'dead_code_explain',
  'module_impact',
  'code_evidence',
  'snapshot_list',
  'diagnostics_list',
  'test_results',
  'snapshot_diff',
  'lint_fix_preview',
  'lint_snapshot',
  'test_snapshot',
  'rsdoctor_analyze',
  'report_link',
] as const;

const withClient = async (callback: (client: Client) => Promise<void>): Promise<void> => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'rstack-context-mcp-'));
  const server = createContextMcpServer(workspaceRoot, { serverVersion: pkgJson.version });
  const client = new Client({ name: 'context-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await callback(client);
  } finally {
    await client.close();
    await server.close();
    await rm(workspaceRoot, { force: true, recursive: true });
  }
};

test('publishes the complete standalone MCP catalog', async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();

    expect(client.getServerVersion()).toEqual({
      name: 'rstack-context',
      version: pkgJson.version,
    });
    expect(tools.map(({ name }) => name)).toEqual(toolNames);
    expect(tools.every(({ inputSchema }) => inputSchema.type === 'object')).toBe(true);
  });
});

test('reports an empty checkout without requiring optional producers', async () => {
  await withClient(async (client) => {
    const result = await client.callTool({ name: 'project_status', arguments: {} });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      schemaVersion: 1,
      workspaceId: expect.stringMatching(/^ws_/),
      contexts: [],
      issues: [],
    });
  });
});
