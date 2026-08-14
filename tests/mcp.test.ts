import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, test } from '@rstest/core';
import pkgJson from '../package.json' with { type: 'json' };
import { createContextMcpServer } from '../src/mcp.ts';
import { writeContextRunManifest, writeContextSnapshot } from '../src/store.ts';

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

const withClient = async (
  callback: (client: Client, workspaceRoot: string) => Promise<void>,
): Promise<void> => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'rstack-context-mcp-'));
  const server = createContextMcpServer(workspaceRoot, { serverVersion: pkgJson.version });
  const client = new Client({ name: 'context-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await callback(client, workspaceRoot);
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

test('keeps project status compact while preserving build selection evidence', async () => {
  await withClient(async (client, workspaceRoot) => {
    const runId = 'run_build';
    const contextId = 'ctx_web';
    expect(
      await writeContextRunManifest(workspaceRoot, {
        schemaVersion: 1,
        runId,
        producer: 'rsbuild',
        command: 'build',
        startedAt: '2026-08-14T03:00:00.000Z',
        contexts: [
          {
            contextId,
            packageRoot: '.',
            product: 'application',
            environment: 'web',
            mode: 'production',
          },
        ],
      }),
    ).toMatchObject({ written: true });
    expect(
      await writeContextSnapshot(workspaceRoot, {
        schemaVersion: 1,
        snapshotId: 'snap_build',
        runId,
        contextId,
        sequence: 1,
        observedAt: '2026-08-14T03:00:01.000Z',
        status: 'pass',
        completeness: { build: 'complete', deep: 'disabled' },
        facets: {
          build: {
            producer: 'rsbuild',
            command: 'build',
            mode: 'production',
            environment: 'web',
            target: ['web'],
            isWatch: false,
            isFirstCompile: true,
            durationMs: 500,
            hash: 'build-hash',
            hasErrors: false,
            hasWarnings: true,
            assets: [{ name: 'assets/app.js', size: 1234 }],
            chunks: [{ files: ['assets/app.js'], initial: true }],
            truncated: { assets: 0, chunks: 0 },
          },
        },
      }),
    ).toMatchObject({ written: true });

    const result = await client.callTool({ name: 'project_status', arguments: {} });

    expect(result.content).toEqual([
      {
        type: 'text',
        text: expect.stringContaining('1 recorded context identity'),
      },
    ]);
    expect(result.structuredContent).toEqual({
      schemaVersion: 1,
      workspaceId: expect.stringMatching(/^ws_/),
      contexts: [
        {
          runId,
          producer: 'rsbuild',
          context: {
            contextId,
            packageRoot: '.',
            product: 'application',
            environment: 'web',
            mode: 'production',
          },
          state: 'ready',
          latestSnapshot: {
            snapshotId: 'snap_build',
            observedAt: '2026-08-14T03:00:01.000Z',
            status: 'pass',
            completeness: { build: 'complete', deep: 'disabled' },
            facets: ['build'],
            summary: {
              build: {
                command: 'build',
                mode: 'production',
                environment: 'web',
                environmentCompileDurationMs: 500,
                hash: 'build-hash',
                hasErrors: false,
                hasWarnings: true,
                assets: 1,
                chunks: 1,
              },
            },
          },
          freshness: { state: 'unknown', changedPaths: [] },
        },
      ],
      issues: [],
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain('assets/app.js');
  });
});
