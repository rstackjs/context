import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, test } from '@rstest/core';
import type { TestRunResult } from '@rstest/core/api';
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
  'related_tests',
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

const createNativeTestResult = (testPath: string): TestRunResult => ({
  status: 'pass',
  results: [
    {
      testId: `file:${testPath}`,
      project: 'default',
      testPath,
      name: path.basename(testPath),
      status: 'pass',
      results: [
        {
          testId: 'case:adds',
          project: 'default',
          testPath,
          name: 'adds',
          status: 'pass',
        },
      ],
    },
  ],
  testResults: [
    {
      testId: 'case:adds',
      project: 'default',
      testPath,
      name: 'adds',
      status: 'pass',
    },
  ],
  summary: {
    tests: { total: 1, passed: 1, failed: 0, skipped: 0, todo: 0 },
    files: { total: 1, failed: 0 },
  },
  duration: { totalTime: 1, buildTime: 0, testTime: 1 },
  snapshotSummary: {
    added: 0,
    failure: false,
    filesAdded: 0,
    filesRemoved: 0,
    filesRemovedList: [],
    filesUnmatched: 0,
    filesUpdated: 0,
    matched: 0,
    total: 0,
    unchecked: 0,
    uncheckedKeysByFile: [],
    unmatched: 0,
    updated: 0,
    didUpdate: false,
  },
  unhandledErrors: [],
});

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

test('serves the Context catalog through the programmatic stdio entry point', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'rstack-context-cli-'));
  const client = new Client({ name: 'context-cli-test-client', version: '1.0.0' });
  const mcpEntry = new URL('../dist/mcp.js', import.meta.url).href;
  await writeFile(
    path.join(workspaceRoot, 'rstest.config.js'),
    `export default { globals: true, include: ['**/*.test.js'] };\n`,
  );
  await writeFile(path.join(workspaceRoot, 'math.js'), 'export const add = (a, b) => a + b;\n');
  await writeFile(
    path.join(workspaceRoot, 'math.test.js'),
    `import { add } from './math.js';\ntest('adds', () => expect(add(1, 2)).toBe(3));\n`,
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      '--input-type=module',
      '--eval',
      `import(${JSON.stringify(mcpEntry)}).then(({ runContextMcpServer }) => runContextMcpServer())`,
    ],
    cwd: workspaceRoot,
    stderr: 'pipe',
  });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map(({ name }) => name)).toEqual(toolNames);
    await expect(
      client.callTool({
        name: 'related_tests',
        arguments: { related: ['math.js'] },
      }),
    ).resolves.toMatchObject({
      structuredContent: {
        sources: ['math.js'],
        testFiles: ['math.test.js'],
        total: 1,
      },
    });
    await expect(
      client.callTool({
        name: 'test_snapshot',
        arguments: { related: ['math.js'] },
      }),
    ).resolves.toMatchObject({
      structuredContent: {
        status: 'pass',
        summary: { files: 1, tests: 1 },
      },
    });
  } finally {
    await client.close();
    await rm(workspaceRoot, { force: true, recursive: true });
  }
});

test('lists native related tests without executing cases or writing a snapshot', async () => {
  const calls: unknown[] = [];
  await withClient(
    async (client, workspaceRoot) => {
      await writeFile(path.join(workspaceRoot, 'source.ts'), 'export const value = 1;\n');
      await writeFile(path.join(workspaceRoot, 'rstest.config.js'), 'export default {};\n');

      const result = await client.callTool({
        name: 'related_tests',
        arguments: { related: ['source.ts'] },
      });

      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.structuredContent).toEqual({
        producer: 'rstest',
        packageRoot: '.',
        sources: ['source.ts'],
        testFiles: ['source.test.ts'],
        total: 1,
      });
      expect(calls).toEqual([
        {
          filesOnly: true,
          filters: [path.join(workspaceRoot, 'source.ts')],
          related: true,
        },
      ]);
      await expect(
        client.callTool({ name: 'snapshot_list', arguments: { producer: 'rstest' } }),
      ).resolves.toMatchObject({ structuredContent: { items: [] } });
    },
    {
      testCaptureDependencies: {
        createRstest: (instanceOptions) =>
          Promise.resolve({
            listTests: (listOptions) => {
              calls.push(listOptions);
              return Promise.resolve([
                {
                  project: 'default',
                  testPath: path.join(instanceOptions?.cwd ?? '.', 'source.test.ts'),
                  type: 'file',
                },
              ]);
            },
            run: () => {
              throw new Error('must not run');
            },
          }),
      },
    },
  );
});

test('rejects native test tools when the selected package has no Rstest config', async () => {
  let createCalls = 0;
  await withClient(
    async (client) => {
      const expected =
        'Rstest is not configured for package root ".". Add a native rstest.config.* file supported by Rstest, or pass configPath.';

      for (const request of [
        { name: 'related_tests', arguments: { related: ['src/index.ts'] } },
        { name: 'test_snapshot', arguments: {} },
      ]) {
        const result = await client.callTool(request);
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([{ type: 'text', text: expected }]);
      }

      expect(createCalls).toBe(0);
      await expect(
        client.callTool({ name: 'project_status', arguments: {} }),
      ).resolves.toMatchObject({ structuredContent: { contexts: [] } });
    },
    {
      testCaptureDependencies: {
        createRstest: async () => {
          createCalls += 1;
          throw new Error('must not create Rstest');
        },
      },
    },
  );
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

      const inputError = await client.callTool({
        name: 'test_snapshot',
        arguments: { files: ['tests/gone.test.ts'] },
      });

      expect(inputError.isError).toBe(true);
      expect(inputError.content).toEqual([
        {
          type: 'text',
          text: expect.stringContaining(
            'Could not read Rstest snapshot inputs: tests/gone.test.ts.',
          ),
        },
      ]);
      await expect(
        client.callTool({ name: 'snapshot_list', arguments: {} }),
      ).resolves.toMatchObject({
        structuredContent: {
          items: expect.arrayContaining([
            expect.objectContaining({
              snapshotId: 'snap_mcp_2',
              status: 'error',
              completeness: { test: 'partial', source: 'partial' },
            }),
          ]),
        },
      });
    },
    {
      testCaptureDependencies: {
        loadConfig: ({ cwd = process.cwd(), path: configPath } = {}) =>
          Promise.resolve({
            content: {},
            filePath: configPath ?? path.join(cwd, 'rstest.config.ts'),
            dependencies: [],
          }),
        createRunId: () => {
          captureCount += 1;
          return `run_mcp_${captureCount}`;
        },
        createSnapshotId: () => `snap_mcp_${captureCount}`,
        createRstest: ({ cwd = process.cwd() } = {}) =>
          Promise.resolve({
            listTests: () => Promise.resolve([]),
            run: (options) =>
              Promise.resolve(
                createNativeTestResult(
                  path.join(cwd, options?.filters?.[0] ?? 'tests/math.test.ts'),
                ),
              ),
          }),
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
            assets: [
              { name: 'assets/app.js', size: 1234 },
              ...Array.from({ length: 99 }, (_, index) => ({
                name: `assets/lazy-${index}.js`,
                size: index,
              })),
            ],
            chunks: [{ files: ['assets/app.js'], initial: true }],
            truncated: { assets: 247, chunks: 0 },
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
                assets: 100,
                chunks: 1,
                total: { assets: 347, chunks: 1 },
                truncated: { assets: 247, chunks: 0 },
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

test('keeps complete project status while summarizing a newer failed attempt', async () => {
  await withClient(async (client, workspaceRoot) => {
    const context = {
      contextId: 'ctx_test',
      packageRoot: '.',
      product: 'development',
      environment: 'test',
    } as const;
    const completeRun: Parameters<typeof writeContextRunManifest>[1] = {
      schemaVersion: 1,
      runId: 'run_complete',
      producer: 'rstest',
      command: 'test',
      startedAt: '2026-08-14T03:00:00.000Z',
      contexts: [context],
    };
    const errorRun: Parameters<typeof writeContextRunManifest>[1] = {
      ...completeRun,
      runId: 'run_error',
      startedAt: '2026-08-14T04:00:00.000Z',
    };
    expect(await writeContextRunManifest(workspaceRoot, completeRun)).toMatchObject({
      written: true,
    });
    expect(
      await writeContextSnapshot(workspaceRoot, {
        schemaVersion: 1,
        snapshotId: 'snap_complete',
        runId: completeRun.runId,
        contextId: context.contextId,
        sequence: 0,
        observedAt: '2026-08-14T03:00:01.000Z',
        status: 'pass',
        completeness: { test: 'complete' },
        facets: { summary: { tests: 1, failedTests: 0 } },
      }),
    ).toMatchObject({ written: true });
    expect(await writeContextRunManifest(workspaceRoot, errorRun)).toMatchObject({ written: true });
    expect(
      await writeContextSnapshot(workspaceRoot, {
        schemaVersion: 1,
        snapshotId: 'snap_error',
        runId: errorRun.runId,
        contextId: context.contextId,
        sequence: 0,
        observedAt: '2026-08-14T04:00:01.000Z',
        status: 'error',
        completeness: { test: 'partial', source: 'partial' },
        facets: { summary: { tests: 1, failedTests: 0, errors: 1 } },
        source: {
          inputs: [],
          inputCompleteness: 'partial',
          unreadableInputs: ['src/missing.ts'],
        },
      }),
    ).toMatchObject({ written: true });

    await expect(client.callTool({ name: 'project_status', arguments: {} })).resolves.toMatchObject(
      {
        structuredContent: {
          contexts: [
            {
              runId: errorRun.runId,
              producer: 'rstest',
              context,
              state: 'ready',
              latestSnapshot: {
                snapshotId: 'snap_complete',
                status: 'pass',
                completeness: { test: 'complete' },
                facets: ['summary'],
              },
              latestAttempt: {
                snapshotId: 'snap_error',
                status: 'error',
                completeness: { test: 'partial', source: 'partial' },
                facets: ['summary'],
              },
            },
          ],
          issues: [],
        },
      },
    );
  });
});
