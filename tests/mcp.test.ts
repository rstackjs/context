import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, test } from '@rstest/core';
import pkgJson from '../package.json' with { type: 'json' };
import { createContextMcpServer, type ContextMcpDependencies } from '../src/mcp.ts';
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
  dependencies: ContextMcpDependencies = {},
): Promise<void> => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'rstack-context-mcp-'));
  const server = createContextMcpServer(workspaceRoot, {
    ...dependencies,
    serverVersion: pkgJson.version,
  });
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
    const codeEvidenceSchema = tools.find(({ name }) => name === 'code_evidence')?.inputSchema as {
      properties?: Record<string, { description?: string }>;
    };
    expect(codeEvidenceSchema.properties?.contextId?.description).toContain(
      'only together with dataFile',
    );
    expect(codeEvidenceSchema.properties?.dataFile?.description).toContain(
      'only together with contextId',
    );
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

test('rejects snapshot cursors reused with different filters', async () => {
  await withClient(async (client, workspaceRoot) => {
    const context = { contextId: 'ctx_web', packageRoot: '.', product: 'application' } as const;
    await writeContextRunManifest(workspaceRoot, {
      schemaVersion: 1,
      runId: 'run_lint',
      producer: 'rslint',
      command: 'lint',
      startedAt: '2026-08-14T03:00:00.000Z',
      contexts: [context],
    });
    await writeContextSnapshot(workspaceRoot, {
      schemaVersion: 1,
      snapshotId: 'snap_lint',
      runId: 'run_lint',
      contextId: context.contextId,
      sequence: 1,
      observedAt: '2026-08-14T03:00:01.000Z',
      status: 'pass',
      completeness: { lint: 'complete' },
      facets: {},
    });
    await writeContextRunManifest(workspaceRoot, {
      schemaVersion: 1,
      runId: 'run_test',
      producer: 'rstest',
      command: 'test',
      startedAt: '2026-08-14T04:00:00.000Z',
      contexts: [context],
    });
    await writeContextSnapshot(workspaceRoot, {
      schemaVersion: 1,
      snapshotId: 'snap_test',
      runId: 'run_test',
      contextId: context.contextId,
      sequence: 1,
      observedAt: '2026-08-14T04:00:01.000Z',
      status: 'pass',
      completeness: { test: 'complete' },
      facets: {},
    });

    const first = await client.callTool({
      name: 'snapshot_list',
      arguments: { limit: 1 },
    });
    const cursor = (first.structuredContent as { nextCursor?: string }).nextCursor;
    expect(cursor).toEqual(expect.any(String));

    const changedFilter = await client.callTool({
      name: 'snapshot_list',
      arguments: { producer: 'rslint', limit: 1, cursor },
    });
    expect(changedFilter.isError).toBe(true);
    expect(changedFilter.content).toEqual([
      { type: 'text', text: expect.stringContaining('Invalid snapshot cursor') },
    ]);
  });
});

test('surfaces requested execution availability in test capture text', async () => {
  await withClient(
    async (client) => {
      const result = await client.callTool({
        name: 'test_snapshot',
        arguments: { packageRoot: '.', execution: {} },
      });

      expect(result.content).toEqual([
        {
          type: 'text',
          text: expect.stringContaining('executionAvailability=unavailable'),
        },
      ]);
      expect(result.structuredContent).toMatchObject({
        status: 'pass',
        execution: {
          provider: 'istanbul',
          availability: 'unavailable',
          completeness: 'unknown',
        },
      });
    },
    {
      captureTestSnapshot: () =>
        Promise.resolve({
          runId: 'run_test',
          contextId: 'ctx_test',
          snapshotId: 'snap_test',
          status: 'pass',
          freshness: { state: 'fresh', changedPaths: [] },
          summary: {
            files: 1,
            failedFiles: 0,
            tests: 1,
            failedTests: 0,
            errors: 0,
            unhandledErrors: 0,
          },
          execution: {
            provider: 'istanbul',
            availability: 'unavailable',
            completeness: 'unknown',
          },
        }),
    },
  );
});

test('captures a real test snapshot through injected capture dependencies', async () => {
  let captureCount = 0;
  await withClient(
    async (client, workspaceRoot) => {
      await mkdir(path.join(workspaceRoot, 'tests'), { recursive: true });
      await writeFile(path.join(workspaceRoot, 'tests', 'math.test.ts'), 'test');

      const result = await client.callTool({
        name: 'test_snapshot',
        arguments: { files: ['tests/math.test.ts'] },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        runId: 'run_mcp_1',
        snapshotId: 'snap_mcp_1',
        status: 'pass',
        summary: { files: 1, tests: 1 },
      });
      await expect(
        client.callTool({ name: 'test_results', arguments: { snapshotId: 'snap_mcp_1' } }),
      ).resolves.toMatchObject({
        structuredContent: {
          snapshotId: 'snap_mcp_1',
          items: [{ path: 'tests/math.test.ts', name: 'adds' }],
        },
      });

      const degraded = await client.callTool({
        name: 'test_snapshot',
        arguments: { files: ['tests/gone.test.ts'] },
      });

      expect(degraded.isError).not.toBe(true);
      expect(degraded.content).toEqual([
        { type: 'text', text: expect.stringContaining('unreadableInputs=1') },
      ]);
      expect(degraded.structuredContent).toMatchObject({
        snapshotId: 'snap_mcp_2',
        status: 'pass',
        unreadableInputs: ['tests/gone.test.ts'],
      });
      await expect(
        client.callTool({ name: 'snapshot_list', arguments: {} }),
      ).resolves.toMatchObject({
        structuredContent: {
          items: expect.arrayContaining([
            expect.objectContaining({
              snapshotId: 'snap_mcp_2',
              completeness: { test: 'complete', source: 'partial' },
            }),
          ]),
        },
      });
    },
    {
      testCaptureDependencies: {
        wrapperConfigPath: path.join(path.sep, 'wrapper', 'rstestConfig.js'),
        createRunId: () => {
          captureCount += 1;
          return `run_mcp_${captureCount}`;
        },
        createSnapshotId: () => `snap_mcp_${captureCount}`,
        runRstest: (options) => {
          const testPath = path.join(
            (options?.cwd as string | undefined) ?? '.',
            (options?.files as string[] | undefined)?.[0] ?? 'tests/math.test.ts',
          );
          return Promise.resolve({
            ok: true,
            files: [
              {
                project: 'default',
                testPath,
                name: path.basename(testPath),
                status: 'pass',
                results: [{ project: 'default', testPath, name: 'adds', status: 'pass' }],
              },
            ],
            stats: {
              tests: { total: 1, passed: 1, failed: 0, skipped: 0, todo: 0 },
              files: { total: 1, failed: 0 },
            },
            unhandledErrors: [],
            duration: { total: 1 },
          });
        },
      },
    },
  );
});

test('captures a real lint snapshot through an injected capture adapter', async () => {
  await withClient(
    async (client, workspaceRoot) => {
      await writeFile(path.join(workspaceRoot, 'a.ts'), 'const a = 1;\n');

      const result = await client.callTool({
        name: 'lint_snapshot',
        arguments: { mode: 'files', patterns: ['a.ts'] },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        status: 'fail',
        summary: { files: 1, errors: 1 },
      });
      await expect(
        client.callTool({ name: 'diagnostics_list', arguments: { producer: 'rslint' } }),
      ).resolves.toMatchObject({
        structuredContent: {
          items: [{ producer: 'rslint', ruleId: 'a-rule', severity: 'error', path: 'a.ts' }],
        },
      });
    },
    {
      lintCaptureAdapter: {
        wrapperConfigPath: path.join(path.sep, 'wrapper', 'rslintConfig.js'),
        withConfigTarget: (_configRoot, _configPath, action) => action(),
      },
      createRslint: (options) => ({
        lintFiles: () =>
          Promise.resolve([
            {
              filePath: path.join(options.cwd ?? '.', 'a.ts'),
              errorCount: 1,
              warningCount: 0,
              fixableErrorCount: 0,
              fixableWarningCount: 0,
              messages: [{ ruleId: 'a-rule', severity: 2, message: 'broken', line: 1, column: 1 }],
            },
          ]),
        lintText: () => Promise.resolve([]),
        close: () => Promise.resolve(),
      }),
    },
  );
});

test('rejects capture targets that escape the checkout', async () => {
  await withClient(
    async (client) => {
      const escaped = await client.callTool({
        name: 'test_snapshot',
        arguments: { packageRoot: '../../..' },
      });
      const escapedConfig = await client.callTool({
        name: 'lint_snapshot',
        arguments: { mode: 'files', configPath: '../../evil.config.ts' },
      });

      expect(escaped.isError).toBe(true);
      expect(escaped.content).toEqual([
        {
          type: 'text',
          text: expect.stringContaining(
            'packageRoot must be a non-empty checkout-relative path that stays inside the checkout.',
          ),
        },
      ]);
      expect(escapedConfig.isError).toBe(true);
      expect(escapedConfig.content).toEqual([
        {
          type: 'text',
          text: expect.stringContaining(
            'configPath must be a non-empty checkout-relative path that stays inside the checkout.',
          ),
        },
      ]);
      await expect(
        client.callTool({ name: 'project_status', arguments: {} }),
      ).resolves.toMatchObject({ structuredContent: { contexts: [] } });
    },
    {
      testCaptureDependencies: {
        wrapperConfigPath: path.join(path.sep, 'wrapper', 'rstestConfig.js'),
        runRstest: () => {
          throw new Error('must not run');
        },
      },
      lintCaptureAdapter: {
        wrapperConfigPath: path.join(path.sep, 'wrapper', 'rslintConfig.js'),
        withConfigTarget: (_configRoot, _configPath, action) => action(),
      },
      createRslint: () => {
        throw new Error('must not run');
      },
    },
  );
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
