/* rslint-disable @typescript-eslint/no-unsafe-assignment -- Rstest asymmetric matchers are intentionally untyped. */
import { mkdir, readFile, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ProcessAssetsHandler,
  RsbuildPlugin,
  RsbuildPluginAPI,
  TransformContext,
  TransformHandler,
} from '@rsbuild/core';
import { expect, test } from '@rstest/core';
import type { ListedTest, ListOptions, RunOptions, TestRunResult } from '@rstest/core/api';
import { listDiagnostics } from '../src/lint.ts';
import { readCodeEvidence } from '../src/codeEvidence.ts';
import { sha256Hex } from '../src/guards.ts';
import { createExecutionSourcePlugin, normalizeExecutionFacet } from '../src/execution.ts';
import { readProjectStatus } from '../src/status.ts';
import { validateTestFacet } from '../src/records.ts';
import { readContextSnapshotById } from '../src/store.ts';
import {
  captureTestSnapshot,
  listRelatedTests,
  listTestResults,
  type CapturedTestRunResult,
  type TestCaptureDependencies,
  type TestSnapshotRequest,
} from '../src/testRun.ts';
import { withTempWorkspace } from './helpers.ts';

const createResult = (overrides: Partial<CapturedTestRunResult> = {}): CapturedTestRunResult => ({
  ok: true,
  files: [],
  stats: {
    tests: { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 },
    files: { total: 0, failed: 0 },
  },
  unhandledErrors: [],
  duration: { total: 0 },
  ...overrides,
});

const toNativeResult = (result: CapturedTestRunResult): TestRunResult => ({
  status: result.unhandledErrors.length > 0 ? 'error' : result.ok ? 'pass' : 'fail',
  results: result.files as TestRunResult['results'],
  testResults: result.files.flatMap((file) => file.results) as TestRunResult['testResults'],
  summary: result.stats,
  duration: { totalTime: result.duration.total, buildTime: 0, testTime: result.duration.total },
  snapshotSummary:
    result.snapshot ??
    ({
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
    } satisfies TestRunResult['snapshotSummary']),
  unhandledErrors: result.unhandledErrors,
  ...(result.coverage === undefined ? {} : { coverage: result.coverage }),
});

const createSourceObserver = async (plugin: RsbuildPlugin) => {
  let transform: TransformHandler<true> | undefined;
  let processAssets: ProcessAssetsHandler | undefined;
  const assets: Parameters<ProcessAssetsHandler>[0]['assets'] = {};
  await plugin.setup({
    transform: (_descriptor, handler) => {
      transform = handler as TransformHandler<true>;
    },
    processAssets: (_descriptor, handler) => {
      processAssets = handler;
    },
  } as RsbuildPluginAPI);
  return async (resourcePath: string, code: Buffer) => {
    await transform!({
      resourcePath,
      code,
      emitFile: (name, content) => {
        assets[name] = { source: () => content } as (typeof assets)[string];
      },
    } as TransformContext<true>);
    await processAssets!({
      assets,
      compilation: {
        deleteAsset: (name: string) => {
          delete assets[name];
        },
      },
    } as Parameters<ProcessAssetsHandler>[0]);
  };
};

const createDependencies = (
  result: CapturedTestRunResult,
  calls: unknown[],
  suffix: string,
  listTests: (options?: ListOptions & RunOptions) => Promise<ListedTest[]> = () =>
    Promise.resolve([]),
): TestCaptureDependencies => ({
  hasCoverageProvider: () => true,
  loadConfig: ({ cwd = process.cwd(), path: configPath } = {}) =>
    Promise.resolve({
      content: {},
      filePath: configPath ?? path.join(cwd, 'rstest.config.ts'),
      dependencies: [],
    }),
  createRstest: async (options) => {
    let observeSource: Awaited<ReturnType<typeof createSourceObserver>> | undefined;
    const config = options?.config;
    if (config !== undefined && 'content' in config) {
      const plugin = config.content.plugins?.at(-1) as RsbuildPlugin | undefined;
      if (plugin !== undefined) observeSource = await createSourceObserver(plugin);
    }
    return {
      listTests,
      run: async (options) => {
        for (const resourcePath of Object.keys(result.coverage ?? {})) {
          const code = await readFile(resourcePath).catch(() => undefined);
          if (code !== undefined) await observeSource?.(resourcePath, code);
        }
        calls.push(options);
        return toNativeResult(result);
      },
    };
  },
  createRunId: () => `run_${suffix}`,
  createSnapshotId: () => `snap_${suffix}`,
  now: () => new Date('2026-08-12T08:00:00.000Z'),
});

test('keeps the coverage provider out of the published dependency surface', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };

  // The Istanbul provider is resolved from the package under test, so declaring it as a
  // peer of this package could not satisfy the runtime lookup; it stays a dev-only dependency.
  expect(packageJson.dependencies?.['@rstest/coverage-istanbul']).toBeUndefined();
  expect(packageJson.devDependencies?.['@rstest/coverage-istanbul']).toBe(
    packageJson.dependencies?.['@rstest/core'],
  );
  expect(packageJson.peerDependencies?.['@rstest/coverage-istanbul']).toBeUndefined();
  expect(packageJson.peerDependenciesMeta?.['@rstest/coverage-istanbul']).toBeUndefined();

  // Rsbuild is a type-only integration surface: an optional peer for consumers of the
  // plugin entry points, never a runtime dependency.
  expect(packageJson.dependencies?.['@rsbuild/core']).toBeUndefined();
  expect(packageJson.peerDependencies?.['@rsbuild/core']).toBe('^2.0.0');
  expect(packageJson.peerDependenciesMeta?.['@rsbuild/core']).toEqual({ optional: true });
});

test('rejects native test capture when no Rstest config exists', async () => {
  await withTempWorkspace('rstack-context-test-run-', async (workspaceRoot) => {
    let createCalls = 0;
    const createRstest = () => {
      createCalls += 1;
      throw new Error('must not create Rstest');
    };
    const message =
      'Rstest is not configured for package root ".". Add a native rstest.config.* file supported by Rstest, or pass configPath.';

    await expect(captureTestSnapshot(workspaceRoot, {}, { createRstest })).rejects.toThrow(message);
    await expect(
      listRelatedTests(workspaceRoot, { related: ['src/index.ts'] }, createRstest),
    ).rejects.toThrow(message);

    expect(createCalls).toBe(0);
    await expect(readProjectStatus(workspaceRoot)).resolves.toMatchObject({ contexts: [] });
  });
});

test('uses Rstest native config discovery for CommonJS config files', async () => {
  await withTempWorkspace('rstack-context-test-run-', async (workspaceRoot) => {
    const configPath = path.join(workspaceRoot, 'rstest.config.cjs');
    const sourcePath = path.join(workspaceRoot, 'src', 'index.ts');
    const testPath = path.join(workspaceRoot, 'src', 'index.test.ts');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(configPath, 'module.exports = {};\n');
    await writeFile(sourcePath, 'export const value = 1;\n');

    const createCalls: unknown[] = [];
    const result = await listRelatedTests(
      workspaceRoot,
      { related: ['src/index.ts'] },
      (options) => {
        createCalls.push(options);
        return Promise.resolve({
          listTests: () => Promise.resolve([{ project: 'default', testPath, type: 'file' }]),
          run: () => {
            throw new Error('must not run');
          },
        });
      },
    );

    expect(createCalls).toEqual([
      expect.objectContaining({
        cwd: workspaceRoot,
        config: expect.objectContaining({ filePath: configPath }),
      }),
    ]);
    expect(result).toMatchObject({
      sources: ['src/index.ts'],
      testFiles: ['src/index.test.ts'],
      total: 1,
    });
  });
});

test('captures one passing run with partial source freshness', async () => {
  await withTempWorkspace('rstack-context-test-run-', async (workspaceRoot) => {
    const testPath = path.join(workspaceRoot, 'src', 'math.test.ts');
    await mkdir(path.dirname(testPath), { recursive: true });
    await writeFile(testPath, 'test');
    const calls: unknown[] = [];
    const result = createResult({
      files: [
        {
          project: 'default',
          testPath,
          name: 'math.test.ts',
          status: 'pass',
          duration: 12,
          results: [
            {
              project: 'default',
              testPath,
              name: 'adds',
              parentNames: ['math'],
              status: 'pass',
              duration: 4,
            },
          ],
        },
      ],
      stats: {
        tests: { total: 1, passed: 1, failed: 0, skipped: 0, todo: 0 },
        files: { total: 1, failed: 0 },
      },
      duration: { total: 18 },
    });

    await expect(
      captureTestSnapshot(
        workspaceRoot,
        { files: ['src/math.test.ts'], testNamePattern: 'adds' },
        createDependencies(result, calls, 'pass'),
      ),
    ).resolves.toEqual({
      runId: 'run_pass',
      contextId: expect.stringMatching(/^ctx_[0-9a-f]{24}$/u),
      snapshotId: 'snap_pass',
      status: 'pass',
      freshness: { state: 'partial', changedPaths: [] },
      summary: {
        files: 1,
        failedFiles: 0,
        tests: 1,
        failedTests: 0,
        errors: 0,
        unhandledErrors: 0,
      },
    });
    expect(calls).toEqual([
      {
        filters: ['src/math.test.ts'],
        testNamePattern: 'adds',
      },
    ]);

    const stored = await readContextSnapshotById(workspaceRoot, 'snap_pass');
    const status = await readProjectStatus(workspaceRoot);
    expect(stored?.snapshot.facets.execution).toBeUndefined();
    expect(stored?.snapshot).toMatchObject({
      status: 'pass',
      completeness: { test: 'complete' },
      source: {
        captureSelection: {
          files: ['src/math.test.ts'],
          testNamePattern: 'adds',
        },
        inputCompleteness: 'partial',
        inputs: [
          {
            path: 'src/math.test.ts',
            digest: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
          },
        ],
      },
      facets: {
        test: {
          producer: 'rstest',
          durationMs: 18,
          unhandledErrors: [],
          files: [
            {
              project: 'default',
              path: 'src/math.test.ts',
              status: 'pass',
              durationMs: 12,
              tests: [
                {
                  project: 'default',
                  path: 'src/math.test.ts',
                  name: 'adds',
                  parentNames: ['math'],
                  status: 'pass',
                  durationMs: 4,
                },
              ],
            },
          ],
        },
      },
    });
    expect(status.contexts[0]?.context).toEqual({
      contextId: expect.stringMatching(/^ctx_[0-9a-f]{24}$/u),
      packageRoot: '.',
      product: 'development',
      configPath: 'rstest.config.ts',
      environment: 'test',
    });

    await expect(listTestResults(workspaceRoot, {})).resolves.toMatchObject({
      snapshotId: 'snap_pass',
      freshness: { state: 'partial', changedPaths: [] },
      total: 1,
      items: [{ project: 'default', path: 'src/math.test.ts', name: 'adds' }],
    });
    await unlink(testPath);
    await expect(listTestResults(workspaceRoot, {})).resolves.toMatchObject({
      snapshotId: 'snap_pass',
      freshness: { state: 'stale', changedPaths: ['src/math.test.ts'] },
    });
  });
});

test('resolves related source files before running and records the static test relation', async () => {
  await withTempWorkspace('rstack-context-test-run-', async (workspaceRoot) => {
    const sourcePath = path.join(workspaceRoot, 'packages', 'app', 'src', 'config.ts');
    const testPath = path.join(workspaceRoot, 'packages', 'app', 'tests', 'config.test.ts');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await mkdir(path.dirname(testPath), { recursive: true });
    await writeFile(sourcePath, 'export const value = 1;\n');
    await writeFile(testPath, 'test');
    const calls: unknown[] = [];
    const listCalls: unknown[] = [];
    const result = createResult({
      files: [
        {
          project: 'default',
          testPath,
          name: 'config.test.ts',
          status: 'pass',
          results: [],
        },
      ],
      stats: {
        tests: { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 },
        files: { total: 1, failed: 0 },
      },
    });

    const capture = await captureTestSnapshot(
      workspaceRoot,
      { packageRoot: 'packages/app', related: ['src/config.ts'] },
      createDependencies(result, calls, 'related', (options) => {
        listCalls.push(options);
        return Promise.resolve([{ project: 'default', testPath, type: 'file' }]);
      }),
    );

    expect(listCalls).toEqual([
      {
        filesOnly: true,
        filters: [sourcePath],
        related: true,
      },
    ]);
    expect(calls).toEqual([
      {
        filters: [sourcePath],
        related: true,
      },
    ]);
    const stored = await readContextSnapshotById(workspaceRoot, capture.snapshotId);
    expect(stored?.snapshot.source).toEqual({
      captureSelection: { related: ['src/config.ts'] },
      inputCompleteness: 'partial',
      inputs: [
        {
          path: 'packages/app/src/config.ts',
          digest: '5d8f65d2774e206bc9f7a7a4ad39ca2dc563b5c31e46ab57ef4874961237ce29',
        },
        {
          path: 'packages/app/tests/config.test.ts',
          digest: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
        },
      ],
    });
    expect(stored?.snapshot.facets.test).toMatchObject({
      relation: {
        sources: ['packages/app/src/config.ts'],
        testFiles: ['packages/app/tests/config.test.ts'],
      },
    });
  });
});

test('persists an actionable error snapshot when a related source file cannot be read', async () => {
  await withTempWorkspace('rstack-context-test-run-', async (workspaceRoot) => {
    const testPath = path.join(workspaceRoot, 'tests', 'config.test.ts');
    await mkdir(path.dirname(testPath), { recursive: true });
    await writeFile(testPath, 'test');
    const calls: unknown[] = [];
    const result = createResult({
      files: [
        {
          project: 'default',
          testPath,
          name: 'config.test.ts',
          status: 'pass',
          results: [],
        },
      ],
      stats: {
        tests: { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 },
        files: { total: 1, failed: 0 },
      },
    });

    await expect(
      captureTestSnapshot(
        workspaceRoot,
        { related: ['src/missing.ts'] },
        createDependencies(result, calls, 'unreadable', () =>
          Promise.resolve([{ project: 'default', testPath, type: 'file' }]),
        ),
      ),
    ).rejects.toMatchObject({
      name: 'TestInputError',
      message:
        'Could not read Rstest snapshot inputs: src/missing.ts. Ensure the selected sources and reported test files exist and are readable.',
    });

    const stored = await readContextSnapshotById(workspaceRoot, 'snap_unreadable');
    expect(stored?.snapshot).toMatchObject({
      status: 'error',
      completeness: { test: 'partial', source: 'partial' },
    });
    expect(stored?.snapshot.source).toEqual({
      captureSelection: { related: ['src/missing.ts'] },
      inputCompleteness: 'partial',
      inputs: [
        {
          path: 'tests/config.test.ts',
          digest: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
        },
      ],
      unreadableInputs: ['src/missing.ts'],
    });
    expect(stored?.snapshot.facets.test).toMatchObject({
      relation: { sources: ['src/missing.ts'], testFiles: ['tests/config.test.ts'] },
      unhandledErrors: [
        {
          name: 'TestInputError',
          message:
            'Could not read Rstest snapshot inputs: src/missing.ts. Ensure the selected sources and reported test files exist and are readable.',
        },
      ],
    });
    await expect(
      listDiagnostics(workspaceRoot, { snapshotId: 'snap_unreadable' }),
    ).resolves.toMatchObject({
      snapshotId: 'snap_unreadable',
      total: 1,
      items: [
        {
          producer: 'rstest',
          severity: 'error',
          message:
            'Could not read Rstest snapshot inputs: src/missing.ts. Ensure the selected sources and reported test files exist and are readable.',
        },
      ],
    });
  });
});

test('keeps the latest complete test results when a newer snapshot has unreadable inputs', async () => {
  await withTempWorkspace('rstack-context-test-run-', async (workspaceRoot) => {
    const sourcePath = path.join(workspaceRoot, 'src', 'config.ts');
    const testPath = path.join(workspaceRoot, 'tests', 'config.test.ts');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await mkdir(path.dirname(testPath), { recursive: true });
    await writeFile(sourcePath, 'export const value = 1;');
    await writeFile(testPath, 'test');
    const result = createResult({
      files: [
        {
          project: 'default',
          testPath,
          name: 'config.test.ts',
          status: 'pass',
          results: [
            {
              project: 'default',
              testPath,
              name: 'reads config',
              parentNames: [],
              status: 'pass',
            },
          ],
        },
      ],
      stats: {
        tests: { total: 1, passed: 1, failed: 0, skipped: 0, todo: 0 },
        files: { total: 1, failed: 0 },
      },
    });
    const complete = await captureTestSnapshot(
      workspaceRoot,
      { related: ['src/config.ts'] },
      createDependencies(result, [], 'complete', () =>
        Promise.resolve([{ project: 'default', testPath, type: 'file' }]),
      ),
    );
    await unlink(sourcePath);
    await expect(
      captureTestSnapshot(
        workspaceRoot,
        { related: ['src/config.ts'] },
        createDependencies(result, [], 'incomplete', () =>
          Promise.resolve([{ project: 'default', testPath, type: 'file' }]),
        ),
      ),
    ).rejects.toMatchObject({ name: 'TestInputError' });

    await expect(listTestResults(workspaceRoot, {})).resolves.toMatchObject({
      snapshotId: complete.snapshotId,
      total: 1,
      items: [{ name: 'reads config', status: 'pass' }],
    });
    await expect(
      listTestResults(workspaceRoot, { snapshotId: 'snap_incomplete' }),
    ).resolves.toMatchObject({
      snapshotId: 'snap_incomplete',
      total: 1,
      items: [{ name: 'reads config', status: 'pass' }],
    });
  });
});

test('runs through one native Rstest instance', async () => {
  await withTempWorkspace('rstack-context-test-run-', async (workspaceRoot) => {
    const calls: unknown[] = [];
    const result = await captureTestSnapshot(
      workspaceRoot,
      {},
      createDependencies(createResult(), calls, 'standalone'),
    );

    expect(result.status).toBe('pass');
    expect(calls).toEqual([{}]);

    await expect(readProjectStatus(workspaceRoot)).resolves.toMatchObject({
      contexts: [{ producer: 'rstest' }],
    });
  });
});

test('rejects capture targets that escape the checkout before writing any run manifest', async () => {
  await withTempWorkspace('rstack-context-test-run-', async (workspaceRoot) => {
    const calls: unknown[] = [];
    const dependencies = createDependencies(createResult(), calls, 'escape');

    await expect(
      captureTestSnapshot(workspaceRoot, { packageRoot: '../../..' }, dependencies),
    ).rejects.toThrow(
      'packageRoot must be a non-empty checkout-relative path that stays inside the checkout.',
    );
    await expect(
      captureTestSnapshot(workspaceRoot, { configPath: '../../evil.config.ts' }, dependencies),
    ).rejects.toThrow(
      'configPath must be a non-empty checkout-relative path that stays inside the checkout.',
    );
    expect(calls).toEqual([]);
    await expect(readProjectStatus(workspaceRoot)).resolves.toMatchObject({ contexts: [] });
  });
});

test('rejects files and related source selection together', async () => {
  await withTempWorkspace('rstack-context-test-run-', async (workspaceRoot) => {
    const calls: unknown[] = [];
    const dependencies = createDependencies(createResult(), calls, 'invalid-related');
    await expect(
      captureTestSnapshot(
        workspaceRoot,
        { files: ['tests/config.test.ts'], related: ['src/config.ts'] },
        dependencies,
      ),
    ).rejects.toThrow('files and related cannot be used together');
    expect(calls).toEqual([]);
  });
});

test('records an empty related selection without falling back to the full test suite', async () => {
  await withTempWorkspace('rstack-context-test-run-', async (workspaceRoot) => {
    const sourcePath = path.join(workspaceRoot, 'src', 'unused.ts');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, 'export const unused = true;\n');
    const calls: unknown[] = [];

    const capture = await captureTestSnapshot(
      workspaceRoot,
      { related: ['src/unused.ts'] },
      createDependencies(createResult(), calls, 'unrelated'),
    );

    expect(calls).toEqual([]);
    expect(capture).toMatchObject({ status: 'pass', summary: { files: 0, tests: 0 } });
    const stored = await readContextSnapshotById(workspaceRoot, capture.snapshotId);
    expect(stored?.snapshot.facets.test).toMatchObject({
      relation: { sources: ['src/unused.ts'], testFiles: [] },
      files: [],
    });
  });
});

test('captures requested aggregate Istanbul execution evidence', async () => {
  await withTempWorkspace('rstack-context-test-run-', async (workspaceRoot) => {
    const testPath = path.join(workspaceRoot, 'src', 'math.test.ts');
    const sourcePath = path.join(workspaceRoot, 'src', 'math.ts');
    const classPath = path.join(workspaceRoot, 'src', 'counter.ts');
    await mkdir(path.dirname(testPath), { recursive: true });
    await writeFile(testPath, 'test');
    await writeFile(sourcePath, 'export const add = (a, b) => a + b;');
    await writeFile(classPath, 'export class Counter {}');
    const calls: unknown[] = [];
    const coverage = {
      [sourcePath]: {
        path: sourcePath,
        statementMap: {
          '1': { start: { line: 2, column: 0 }, end: { line: 2, column: 12 } },
          '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 36 } },
        },
        fnMap: {
          '0': {
            name: 'add',
            decl: {
              start: { line: 1, column: 13 },
              end: { line: 1, column: 16 },
            },
            loc: {
              start: { line: 1, column: 19 },
              end: { line: 1, column: 36 },
            },
          },
        },
        branchMap: {
          '0': {
            type: 'binary-expr',
            loc: {
              start: { line: 1, column: 27 },
              end: { line: 1, column: 32 },
            },
            locations: [
              { start: { line: 1, column: 27 }, end: { line: 1, column: 28 } },
              { start: { line: 1, column: 31 }, end: { line: 1, column: 32 } },
            ],
          },
        },
        s: { '0': 2, '1': 0 },
        f: { '0': 2 },
        b: { '0': [2, 0] },
      },
      [classPath]: {
        data: {
          path: classPath,
          statementMap: {
            '0': {
              start: { line: 1, column: 0 },
              end: { line: 1, column: 23 },
            },
          },
          fnMap: {},
          branchMap: {},
          s: { '0': 1 },
          f: {},
          b: {},
        },
      },
    } as unknown as NonNullable<CapturedTestRunResult['coverage']>;
    const result = createResult({
      coverage,
      files: [
        {
          project: 'default',
          testPath,
          name: 'math.test.ts',
          status: 'pass',
          results: [],
        },
      ],
    });

    const capture = await captureTestSnapshot(
      workspaceRoot,
      {
        execution: {
          include: ['src/**/*.ts'],
          exclude: ['src/**/*.test.ts'],
          allowExternal: true,
        },
      },
      createDependencies(result, calls, 'execution'),
    );

    expect(calls).toEqual([
      {
        coverage: {
          enabled: true,
          provider: 'istanbul',
          reporters: [],
          reportOnFailure: true,
          include: ['src/**/*.ts'],
          exclude: ['src/**/*.test.ts'],
          allowExternal: true,
        },
      },
    ]);
    const stored = await readContextSnapshotById(workspaceRoot, capture.snapshotId);
    expect(stored?.snapshot.completeness).toEqual({
      test: 'complete',
      execution: 'complete',
    });
    expect(stored?.snapshot.facets.execution).toEqual({
      producer: 'rstest',
      provider: 'istanbul',
      availability: 'available',
      requestedSelection: {
        include: ['src/**/*.ts'],
        exclude: ['src/**/*.test.ts'],
        allowExternal: true,
      },
      digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      universe: {
        reportedFiles: 2,
        storedFiles: 2,
        droppedFiles: 0,
        reportedLocations: 8,
        storedLocations: 8,
        droppedLocations: 0,
        completeness: 'complete',
      },
      truncated: { files: 0, locations: 0 },
      bounds: {
        attribution: 'aggregate-run-only',
        testAttribution: false,
        maxFiles: 1000,
        maxLocationsPerFile: 20_000,
        maxLocationsTotal: 100_000,
      },
      files: [
        {
          path: 'src/counter.ts',
          digest: '56487e6af58165f47f737975f5cef61ad6dfc7c0c59af4807dcdf993d931570a',
          statements: [
            {
              id: '0',
              location: {
                start: { line: 1, column: 0 },
                end: { line: 1, column: 23 },
              },
              hits: 1,
            },
          ],
          functions: [],
          branches: [],
        },
        {
          path: 'src/math.ts',
          digest: '5040544f09224c8ba67da55ac47c01b1d1ab917a8d07c0a42f00cf14c570f5a9',
          statements: [
            {
              id: '0',
              location: {
                start: { line: 1, column: 0 },
                end: { line: 1, column: 36 },
              },
              hits: 2,
            },
            {
              id: '1',
              location: {
                start: { line: 2, column: 0 },
                end: { line: 2, column: 12 },
              },
              hits: 0,
            },
          ],
          functions: [
            {
              id: '0',
              name: 'add',
              declaration: {
                start: { line: 1, column: 13 },
                end: { line: 1, column: 16 },
              },
              location: {
                start: { line: 1, column: 19 },
                end: { line: 1, column: 36 },
              },
              hits: 2,
            },
          ],
          branches: [
            {
              id: '0',
              type: 'binary-expr',
              location: {
                start: { line: 1, column: 27 },
                end: { line: 1, column: 32 },
              },
              arms: [
                {
                  location: {
                    start: { line: 1, column: 27 },
                    end: { line: 1, column: 28 },
                  },
                  hits: 2,
                },
                {
                  location: {
                    start: { line: 1, column: 31 },
                    end: { line: 1, column: 32 },
                  },
                  hits: 0,
                },
              ],
            },
          ],
        },
      ],
    });
    expect(stored?.snapshot.source?.inputs?.map((input) => input.path)).toEqual([
      'src/counter.ts',
      'src/math.test.ts',
      'src/math.ts',
    ]);
  });
});

test('records requested execution as unavailable when Rstest returns no coverage map', async () => {
  await withTempWorkspace('rstack-context-test-run-', async (workspaceRoot) => {
    const calls: unknown[] = [];
    const capture = await captureTestSnapshot(
      workspaceRoot,
      { execution: {} },
      createDependencies(createResult(), calls, 'execution-unavailable'),
    );

    expect(calls).toEqual([
      {
        coverage: {
          enabled: true,
          provider: 'istanbul',
          reporters: [],
          reportOnFailure: true,
          allowExternal: false,
        },
      },
    ]);
    await expect(readContextSnapshotById(workspaceRoot, capture.snapshotId)).resolves.toMatchObject(
      {
        snapshot: {
          completeness: { test: 'complete', execution: 'partial' },
          facets: {
            execution: {
              producer: 'rstest',
              provider: 'istanbul',
              availability: 'unavailable',
              requestedSelection: { allowExternal: false },
              digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
              universe: {
                reportedFiles: 0,
                storedFiles: 0,
                droppedFiles: 0,
                reportedLocations: 0,
                storedLocations: 0,
                droppedLocations: 0,
                completeness: 'unknown',
              },
              truncated: { files: 0, locations: 0 },
              bounds: {
                attribution: 'aggregate-run-only',
                testAttribution: false,
              },
              files: [],
            },
          },
        },
      },
    );
  });
});

test('runs tests without coverage when the optional Istanbul provider is unavailable', async () => {
  await withTempWorkspace('rstack-context-test-run-', async (workspaceRoot) => {
    const testPath = path.join(workspaceRoot, 'src', 'math.test.ts');
    await mkdir(path.dirname(testPath), { recursive: true });
    await writeFile(testPath, 'test');
    const calls: unknown[] = [];
    const result = createResult({
      files: [
        {
          project: 'default',
          testPath,
          name: 'math.test.ts',
          status: 'pass',
          results: [],
        },
      ],
      stats: {
        tests: { total: 1, passed: 1, failed: 0, skipped: 0, todo: 0 },
        files: { total: 1, failed: 0 },
      },
    });

    const capture = await captureTestSnapshot(
      workspaceRoot,
      { files: ['src/math.test.ts'], execution: { include: ['src/math.ts'] } },
      {
        ...createDependencies(result, calls, 'provider-unavailable'),
        hasCoverageProvider: () => false,
      } satisfies TestCaptureDependencies,
    );

    expect(calls).toEqual([
      {
        filters: ['src/math.test.ts'],
      },
    ]);
    expect(capture).toMatchObject({
      status: 'pass',
      summary: { files: 1, tests: 1 },
      execution: {
        provider: 'istanbul',
        availability: 'unavailable',
        completeness: 'unknown',
      },
    });
    await expect(readContextSnapshotById(workspaceRoot, capture.snapshotId)).resolves.toMatchObject(
      {
        snapshot: {
          status: 'pass',
          completeness: { test: 'complete', execution: 'partial' },
          facets: {
            execution: {
              provider: 'istanbul',
              availability: 'unavailable',
              requestedSelection: { include: ['src/math.ts'], allowExternal: false },
            },
          },
        },
      },
    );
  });
});

test('persists partial execution evidence when a covered source path is unreadable', async () => {
  await withTempWorkspace('rstack-context-test-run-', async (workspaceRoot) => {
    const testPath = path.join(workspaceRoot, 'src', 'present.test.ts');
    const missingPath = path.join(workspaceRoot, 'src', 'missing.ts');
    await mkdir(path.dirname(testPath), { recursive: true });
    await writeFile(testPath, 'test');
    const coverage = {
      [missingPath]: {
        path: missingPath,
        statementMap: {
          '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
        },
        fnMap: {},
        branchMap: {},
        s: { '0': 1 },
        f: {},
        b: {},
      },
    } as unknown as NonNullable<CapturedTestRunResult['coverage']>;
    const result = createResult({
      files: [
        {
          project: 'default',
          testPath,
          name: 'present.test.ts',
          status: 'pass',
          results: [],
        },
      ],
      coverage,
    });
    const calls: unknown[] = [];

    const capture = await captureTestSnapshot(
      workspaceRoot,
      { execution: {} },
      createDependencies(result, calls, 'execution-unreadable'),
    );
    const stored = await readContextSnapshotById(workspaceRoot, capture.snapshotId);

    expect(stored?.snapshot.completeness).toEqual({ test: 'complete', execution: 'partial' });
    expect(stored?.snapshot.source).toEqual({
      captureSelection: {},
      inputCompleteness: 'partial',
      inputs: [
        {
          path: 'src/present.test.ts',
          digest: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
        },
      ],
    });
    expect(stored?.snapshot.facets.execution).toMatchObject({
      availability: 'available',
      universe: { completeness: 'partial' },
      files: [
        {
          path: 'src/missing.ts',
          statements: [{ id: '0', hits: 1 }],
        },
      ],
    });
    expect(
      (stored?.snapshot.facets.execution as { files: Array<{ digest?: string }> }).files[0]?.digest,
    ).toBeUndefined();
  });
});

test('bounds requested execution selectors before invoking Rstest', async () => {
  await withTempWorkspace('rstack-context-test-run-', async (workspaceRoot) => {
    let called = false;
    const dependencies: TestCaptureDependencies = {
      createRstest: () => {
        called = true;
        throw new Error('must not create Rstest');
      },
    };

    await expect(
      captureTestSnapshot(
        workspaceRoot,
        {
          execution: {
            include: Array.from({ length: 201 }, (_, index) => `${index}.ts`),
          },
        },
        dependencies,
      ),
    ).rejects.toThrow('Execution include must contain at most 200 patterns.');
    expect(called).toBe(false);
  });
});

test('rejects malformed execution selectors before invoking Rstest', async () => {
  await withTempWorkspace('rstack-context-test-run-', async (workspaceRoot) => {
    let called = false;
    const dependencies: TestCaptureDependencies = {
      createRstest: () => {
        called = true;
        throw new Error('must not create Rstest');
      },
    };

    await expect(
      captureTestSnapshot(
        workspaceRoot,
        { execution: { include: 'src/**/*.ts' as unknown as string[] } },
        dependencies,
      ),
    ).rejects.toThrow('Execution include must be an array of string patterns.');
    await expect(
      captureTestSnapshot(
        workspaceRoot,
        { execution: { exclude: [42] as unknown as string[] } },
        dependencies,
      ),
    ).rejects.toThrow('Execution exclude must be an array of string patterns.');
    await expect(
      captureTestSnapshot(
        workspaceRoot,
        { execution: { allowExternal: 'yes' as unknown as boolean } },
        dependencies,
      ),
    ).rejects.toThrow('Execution allowExternal must be a boolean.');
    expect(called).toBe(false);
  });
});

test('truncates aggregate execution files deterministically', async () => {
  await withTempWorkspace('rstack-context-test-run-', async (workspaceRoot) => {
    const coverage: Record<string, unknown> = {};
    const sourceDirectory = path.join(workspaceRoot, 'src');
    await mkdir(sourceDirectory, { recursive: true });
    const writes: Array<Promise<void>> = [];
    for (let index = 1000; index >= 0; index -= 1) {
      const sourcePath = path.join(sourceDirectory, `${index.toString().padStart(4, '0')}.ts`);
      writes.push(writeFile(sourcePath, 'export {};'));
      coverage[sourcePath] = {
        path: sourcePath,
        statementMap: {},
        fnMap: {},
        branchMap: {},
        s: {},
        f: {},
        b: {},
      };
    }
    await Promise.all(writes);
    const calls: unknown[] = [];
    const capture = await captureTestSnapshot(
      workspaceRoot,
      { execution: {} },
      createDependencies(
        createResult({
          coverage: coverage as NonNullable<CapturedTestRunResult['coverage']>,
        }),
        calls,
        'execution-truncated',
      ),
    );

    const stored = await readContextSnapshotById(workspaceRoot, capture.snapshotId);
    expect(stored?.snapshot.completeness.execution).toBe('partial');
    expect(stored?.snapshot.facets.execution).toMatchObject({
      availability: 'available',
      universe: {
        reportedFiles: 1001,
        storedFiles: 1000,
        droppedFiles: 1,
        completeness: 'partial',
      },
      truncated: { files: 1, locations: 0 },
    });
    const files = (
      stored?.snapshot.facets.execution as { files?: Array<{ path: string }> } | undefined
    )?.files;
    expect(files).toHaveLength(1000);
    expect(files?.slice(0, 3)).toEqual([
      {
        path: 'src/0000.ts',
        digest: '2e29cd9a98755c46896f7a2d56524db2d6d96b248e36db46de14c30bf47c8d05',
        statements: [],
        functions: [],
        branches: [],
      },
      {
        path: 'src/0001.ts',
        digest: '2e29cd9a98755c46896f7a2d56524db2d6d96b248e36db46de14c30bf47c8d05',
        statements: [],
        functions: [],
        branches: [],
      },
      {
        path: 'src/0002.ts',
        digest: '2e29cd9a98755c46896f7a2d56524db2d6d96b248e36db46de14c30bf47c8d05',
        statements: [],
        functions: [],
        branches: [],
      },
    ]);
  });
}, 15_000);

test('normalizes failures, retries, skipped and todo cases', async () => {
  await withTempWorkspace('rstack-context-test-run-', async (workspaceRoot) => {
    const testPath = path.join(workspaceRoot, 'tests', 'mixed.test.ts');
    await mkdir(path.dirname(testPath), { recursive: true });
    await writeFile(testPath, 'test');
    const calls: unknown[] = [];
    const result = createResult({
      ok: false,
      files: [
        {
          project: 'node',
          testPath,
          name: 'mixed.test.ts',
          status: 'fail',
          errors: [{ name: 'FileError', message: 'file failed' }],
          results: [
            {
              project: 'node',
              testPath,
              name: 'eventually fails',
              status: 'fail',
              errors: [
                {
                  name: 'AssertionError',
                  message: 'expected true',
                  stack: 'stack',
                  diff: '- false\n+ true',
                  actual: 'false',
                  expected: 'true',
                  retryCount: 2,
                },
              ],
              retryErrors: [{ name: 'Error', message: 'attempt one' }],
              retryCount: 2,
            },
            { project: 'node', testPath, name: 'skipped', status: 'skip' },
            { project: 'node', testPath, name: 'later', status: 'todo' },
          ],
        },
      ],
      stats: {
        tests: { total: 3, passed: 0, failed: 1, skipped: 1, todo: 1 },
        files: { total: 1, failed: 1 },
      },
      duration: { total: 30 },
    });

    const capture = await captureTestSnapshot(
      workspaceRoot,
      {},
      createDependencies(result, calls, 'failed'),
    );
    expect(capture.status).toBe('fail');
    const stored = await readContextSnapshotById(workspaceRoot, capture.snapshotId);
    expect(stored?.snapshot.facets.test).toMatchObject({
      files: [
        {
          status: 'fail',
          tests: [
            {
              name: 'eventually fails',
              status: 'fail',
              errors: [
                {
                  name: 'AssertionError',
                  message: 'expected true',
                  stack: 'stack',
                  diff: '- false\n+ true',
                  actual: 'false',
                  expected: 'true',
                  retryCount: 2,
                },
              ],
              retryErrors: [{ name: 'Error', message: 'attempt one' }],
              retryCount: 2,
            },
            { name: 'later', status: 'todo' },
            { name: 'skipped', status: 'skip' },
          ],
        },
      ],
    });
  });
});

test('captures file-level failures without inventing test cases', async () => {
  await withTempWorkspace('rstack-context-test-run-', async (workspaceRoot) => {
    const testPath = path.join(workspaceRoot, 'tests', 'broken.test.ts');
    await mkdir(path.dirname(testPath), { recursive: true });
    await writeFile(testPath, 'invalid');
    const calls: unknown[] = [];
    const result = createResult({
      ok: false,
      files: [
        {
          project: 'node',
          testPath,
          name: 'broken.test.ts',
          status: 'fail',
          errors: [
            {
              name: 'ImportError',
              message: 'could not import setup module',
              stack: 'import stack',
            },
          ],
          results: [],
        },
      ],
      stats: {
        tests: { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 },
        files: { total: 1, failed: 1 },
      },
    });

    const capture = await captureTestSnapshot(
      workspaceRoot,
      {},
      createDependencies(result, calls, 'file-error'),
    );

    expect(capture).toMatchObject({
      status: 'fail',
      summary: { errors: 1 },
      errors: [
        {
          scope: 'file',
          project: 'node',
          path: 'tests/broken.test.ts',
          name: 'ImportError',
          message: 'could not import setup module',
          stack: 'import stack',
        },
      ],
    });

    expect(
      (await readContextSnapshotById(workspaceRoot, capture.snapshotId))?.snapshot.facets.test,
    ).toMatchObject({
      files: [
        {
          project: 'node',
          path: 'tests/broken.test.ts',
          status: 'fail',
          errors: [
            {
              name: 'ImportError',
              message: 'could not import setup module',
              stack: 'import stack',
            },
          ],
          tests: [],
        },
      ],
    });
    await expect(
      listDiagnostics(workspaceRoot, { snapshotId: capture.snapshotId }),
    ).resolves.toMatchObject({
      total: 1,
      items: [
        {
          producer: 'rstest',
          project: 'node',
          path: 'tests/broken.test.ts',
          severity: 'error',
          message: 'could not import setup module',
        },
      ],
    });
    await expect(listTestResults(workspaceRoot, {})).resolves.toEqual({
      producer: 'rstest',
      contextId: capture.contextId,
      snapshotId: capture.snapshotId,
      observedAt: '2026-08-12T08:00:00.000Z',
      completeness: { test: 'complete' },
      freshness: { state: 'partial', changedPaths: [] },
      total: 0,
      items: [],
    });
  });
});

test('records unhandled Rstest errors as an error snapshot', async () => {
  await withTempWorkspace('rstack-context-test-run-', async (workspaceRoot) => {
    const calls: unknown[] = [];
    const result = createResult({
      ok: false,
      unhandledErrors: [
        {
          name: 'ConfigError',
          message: 'configuration failed',
          stack: 'config stack',
        },
      ],
    });

    const capture = await captureTestSnapshot(
      workspaceRoot,
      {},
      createDependencies(result, calls, 'error'),
    );
    expect(capture).toMatchObject({
      snapshotId: 'snap_error',
      status: 'error',
      freshness: { state: 'partial', changedPaths: [] },
      summary: { unhandledErrors: 1 },
      errors: [
        {
          scope: 'run',
          name: 'ConfigError',
          message: 'configuration failed',
          stack: 'config stack',
        },
      ],
      unhandledErrors: [
        {
          name: 'ConfigError',
          message: 'configuration failed',
          stack: 'config stack',
        },
      ],
    });
    expect(
      (await readContextSnapshotById(workspaceRoot, capture.snapshotId))?.snapshot.facets,
    ).toMatchObject({
      test: {
        unhandledErrors: [
          {
            name: 'ConfigError',
            message: 'configuration failed',
            stack: 'config stack',
          },
        ],
      },
    });
  });
});

test('persists a thrown Rstest configuration error as a completed diagnostic snapshot', async () => {
  await withTempWorkspace('rstack-context-test-run-', async (workspaceRoot) => {
    const configError = new Error('configuration failed');
    configError.name = 'ConfigError';
    const dependencies: TestCaptureDependencies = {
      loadConfig: ({ cwd = process.cwd(), path: configPath } = {}) =>
        Promise.resolve({
          content: {},
          filePath: configPath ?? path.join(cwd, 'rstest.config.ts'),
          dependencies: [],
        }),
      createRstest: () =>
        Promise.resolve({
          listTests: () => Promise.resolve([]),
          run: async () => {
            await expect(readProjectStatus(workspaceRoot)).resolves.toMatchObject({
              contexts: [{ runId: 'run_thrown', state: 'pending' }],
            });
            throw configError;
          },
        }),
      createRunId: () => 'run_thrown',
      createSnapshotId: () => 'snap_thrown',
      now: () => new Date('2026-08-12T08:00:00.000Z'),
    };

    await expect(captureTestSnapshot(workspaceRoot, {}, dependencies)).rejects.toBe(configError);

    const stored = await readContextSnapshotById(workspaceRoot, 'snap_thrown');
    expect(stored?.snapshot).toMatchObject({
      runId: 'run_thrown',
      status: 'error',
      completeness: { test: 'partial' },
      facets: {
        test: {
          producer: 'rstest',
          files: [],
          stats: {
            tests: { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 },
            files: { total: 0, failed: 0 },
          },
          durationMs: 0,
          unhandledErrors: [
            {
              name: 'ConfigError',
              message: 'configuration failed',
              stack: expect.any(String),
            },
          ],
        },
      },
    });
    await expect(
      listDiagnostics(workspaceRoot, { snapshotId: 'snap_thrown' }),
    ).resolves.toMatchObject({
      snapshotId: 'snap_thrown',
      total: 1,
      items: [
        {
          producer: 'rstest',
          severity: 'error',
          message: 'configuration failed',
        },
      ],
    });
  });
});

test('pages project-qualified results in deterministic identity order', async () => {
  await withTempWorkspace('rstack-context-test-run-', async (workspaceRoot) => {
    const testPath = path.join(workspaceRoot, 'tests', 'shared.test.ts');
    await mkdir(path.dirname(testPath), { recursive: true });
    await writeFile(testPath, 'test');
    const calls: unknown[] = [];
    const result = createResult({
      files: [
        {
          project: 'web',
          testPath,
          name: 'shared.test.ts',
          status: 'pass',
          results: [
            { project: 'web', testPath, name: 'zeta', status: 'pass' },
            {
              project: 'web',
              testPath,
              parentNames: ['suite'],
              name: 'alpha',
              status: 'skip',
            },
          ],
        },
        {
          project: 'node',
          testPath,
          name: 'shared.test.ts',
          status: 'pass',
          results: [{ project: 'node', testPath, name: 'zeta', status: 'todo' }],
        },
      ],
      stats: {
        tests: { total: 3, passed: 1, failed: 0, skipped: 1, todo: 1 },
        files: { total: 2, failed: 0 },
      },
    });
    const capture = await captureTestSnapshot(
      workspaceRoot,
      {},
      createDependencies(result, calls, 'projects'),
    );

    const first = await listTestResults(workspaceRoot, {
      snapshotId: capture.snapshotId,
      pathPrefix: 'tests/',
      limit: 2,
    });
    expect(first).toEqual({
      producer: 'rstest',
      contextId: capture.contextId,
      snapshotId: capture.snapshotId,
      observedAt: '2026-08-12T08:00:00.000Z',
      completeness: { test: 'complete' },
      freshness: { state: 'partial', changedPaths: [] },
      total: 3,
      items: [
        {
          project: 'node',
          path: 'tests/shared.test.ts',
          name: 'zeta',
          status: 'todo',
        },
        {
          project: 'web',
          path: 'tests/shared.test.ts',
          name: 'zeta',
          status: 'pass',
        },
      ],
      nextCursor: expect.any(String),
    });
    await expect(
      listTestResults(workspaceRoot, {
        snapshotId: capture.snapshotId,
        pathPrefix: 'tests/',
        status: 'pass',
        limit: 2,
        cursor: first.nextCursor,
      }),
    ).rejects.toThrow('Invalid test result cursor');
    await expect(
      listTestResults(workspaceRoot, {
        snapshotId: capture.snapshotId,
        pathPrefix: 'tests/',
        limit: 2,
        cursor: first.nextCursor,
      }),
    ).resolves.toEqual({
      producer: 'rstest',
      contextId: capture.contextId,
      snapshotId: capture.snapshotId,
      observedAt: '2026-08-12T08:00:00.000Z',
      completeness: { test: 'complete' },
      freshness: { state: 'partial', changedPaths: [] },
      total: 3,
      items: [
        {
          project: 'web',
          path: 'tests/shared.test.ts',
          parentNames: ['suite'],
          name: 'alpha',
          status: 'skip',
        },
      ],
    });
    await expect(
      listTestResults(workspaceRoot, { project: 'web', status: 'skip' }),
    ).resolves.toMatchObject({
      total: 1,
      items: [{ project: 'web', name: 'alpha', status: 'skip' }],
    });
  });
});

const nestedCause = (depth: number): CapturedTestRunResult['unhandledErrors'][number] => ({
  name: `Cause${depth}`,
  message: `cause ${depth}`,
  ...(depth === 0 ? {} : { cause: nestedCause(depth - 1) }),
});

const causeChainLength = (error: unknown): number => {
  let links = 0;
  let current = error;
  while (
    typeof current === 'object' &&
    current !== null &&
    (current as { cause?: unknown }).cause !== undefined
  ) {
    links += 1;
    current = (current as { cause?: unknown }).cause;
  }
  return links;
};

test('carries serialized error causes and task metadata through capture and listing', async () => {
  await withTempWorkspace('rstack-context-test-run-', async (workspaceRoot) => {
    const testPath = path.join(workspaceRoot, 'tests', 'fidelity.test.ts');
    await mkdir(path.dirname(testPath), { recursive: true });
    await writeFile(testPath, 'test');
    const calls: unknown[] = [];
    const result = createResult({
      ok: false,
      files: [
        {
          project: 'node',
          testPath,
          name: 'fidelity.test.ts',
          status: 'fail',
          results: [
            {
              project: 'node',
              testPath,
              name: 'reports a wrapped failure',
              status: 'fail',
              errors: [
                {
                  name: 'AssertionError',
                  message: 'outer',
                  cause: {
                    name: 'TypeError',
                    message: 'middle',
                    cause: { name: 'RangeError', message: 'root' },
                  },
                },
              ],
              // Deliberately unsorted so the stored record proves key normalization.
              meta: { zeta: [1, { beta: true }], alpha: 'first', nested: { b: null, a: 2 } },
            },
          ],
        },
      ],
      stats: {
        tests: { total: 1, passed: 0, failed: 1, skipped: 0, todo: 0 },
        files: { total: 1, failed: 1 },
      },
    });

    const capture = await captureTestSnapshot(
      workspaceRoot,
      {},
      createDependencies(result, calls, 'fidelity'),
    );
    const stored = (await readContextSnapshotById(workspaceRoot, capture.snapshotId))?.snapshot
      .facets.test;

    // The snapshot only round-trips through the store if the strict validator accepts the
    // new optional fields, so validation is the assertion that matters here.
    expect(validateTestFacet(stored)).not.toBeUndefined();
    expect(stored).toMatchObject({
      files: [
        {
          tests: [
            {
              name: 'reports a wrapped failure',
              errors: [
                {
                  name: 'AssertionError',
                  message: 'outer',
                  cause: {
                    name: 'TypeError',
                    message: 'middle',
                    cause: { name: 'RangeError', message: 'root' },
                  },
                },
              ],
              meta: { alpha: 'first', nested: { a: 2, b: null }, zeta: [1, { beta: true }] },
            },
          ],
        },
      ],
    });
    const storedMeta = (
      stored as unknown as { files: Array<{ tests: Array<{ meta: Record<string, unknown> }> }> }
    ).files[0].tests[0].meta;
    expect(Object.keys(storedMeta)).toEqual(['alpha', 'nested', 'zeta']);
    expect(Object.keys(storedMeta.nested as Record<string, unknown>)).toEqual(['a', 'b']);

    const listed = await listTestResults(workspaceRoot, {});
    expect(listed.items[0]).toMatchObject({
      meta: { alpha: 'first' },
      errors: [{ cause: { cause: { name: 'RangeError' } } }],
    });
  });
});

test('truncates pathological cause chains and drops metadata that is not JSON-safe', async () => {
  await withTempWorkspace('rstack-context-test-run-', async (workspaceRoot) => {
    const testPath = path.join(workspaceRoot, 'tests', 'pathological.test.ts');
    await mkdir(path.dirname(testPath), { recursive: true });
    await writeFile(testPath, 'test');
    const calls: unknown[] = [];
    const result = createResult({
      ok: false,
      files: [
        {
          project: 'node',
          testPath,
          name: 'pathological.test.ts',
          status: 'fail',
          results: [
            {
              project: 'node',
              testPath,
              name: 'deeply wrapped',
              status: 'fail',
              errors: [nestedCause(30)],
              meta: { fn: (() => undefined) as never },
            },
          ],
        },
      ],
      stats: {
        tests: { total: 1, passed: 0, failed: 1, skipped: 0, todo: 0 },
        files: { total: 1, failed: 1 },
      },
    });

    const capture = await captureTestSnapshot(
      workspaceRoot,
      {},
      createDependencies(result, calls, 'pathological'),
    );
    const stored = (await readContextSnapshotById(workspaceRoot, capture.snapshotId))?.snapshot
      .facets.test;
    expect(validateTestFacet(stored)).not.toBeUndefined();
    const storedTest = (
      stored as unknown as {
        files: Array<{ tests: Array<Record<string, unknown>> }>;
      }
    ).files[0].tests[0];
    expect(causeChainLength((storedTest.errors as unknown[])[0])).toBe(8);
    expect(storedTest.meta).toBeUndefined();
  });
});

type AssertNever<T extends never> = T;
type UnsupportedRequestFields = AssertNever<
  Extract<
    keyof TestSnapshotRequest,
    'apply' | 'changed' | 'reporter' | 'shard' | 'update' | 'watch'
  >
>;

test('keeps unsupported execution controls out of snapshot requests', () => {
  const unsupportedRequestField = undefined as UnsupportedRequestFields;
  expect(unsupportedRequestField).toBeUndefined();
});

test.each(['single', 'cached', 'inline', 'file', 'glob', 'mixed'] as const)(
  'binds execution to compiled sources when a test edits its input (projects: %s)',
  async (projects) => {
    await withTempWorkspace('rstack-context-execution-', async (temporaryRoot) => {
      const workspaceRoot = await realpath(temporaryRoot);
      await symlink(
        fileURLToPath(new URL('../node_modules', import.meta.url)),
        path.join(workspaceRoot, 'node_modules'),
      );
      await writeFile(path.join(workspaceRoot, 'package.json'), '{"type":"module"}');
      const inlineProject = { name: 'app', include: ['src/*.test.ts'] };
      const config = {
        single: { include: ['src/*.test.ts'] },
        cached: { include: ['src/*.test.ts'], performance: { buildCache: true } },
        inline: { projects: [inlineProject] },
        file: { projects: ['./project.config.mjs'] },
        glob: { projects: ['./project.*.mjs'] },
        mixed: { projects: ['./project.config.mjs', inlineProject] },
      }[projects];
      await writeFile(
        path.join(workspaceRoot, 'rstest.config.mjs'),
        `export default ${JSON.stringify(config)};`,
      );
      await writeFile(
        path.join(workspaceRoot, 'project.config.mjs'),
        'export default { name: "external", include: ["src/*.test.ts"] };',
      );
      await mkdir(path.join(workspaceRoot, 'src'));
      const sourcePath = path.join(workspaceRoot, 'src/math.ts');
      const originalSource = 'export function math() { return 1; }\n';
      await writeFile(sourcePath, originalSource);
      const testPath = path.join(workspaceRoot, 'src/math.test.ts');
      const testSource = `import { test, expect } from '@rstest/core';
import { writeFileSync } from 'node:fs';
import { math } from './math';
test('math', () => { expect(math()).toBe(1); EDIT_SOURCE });`;
      await writeFile(testPath, testSource.replace('EDIT_SOURCE', ''));
      const request = { related: ['src/math.ts'], execution: { include: ['src/math.ts'] } };
      const initial = await captureTestSnapshot(workspaceRoot, request);
      expect(initial.status).toBe('pass');
      const unbound = projects === 'file' || projects === 'glob' || projects === 'mixed';
      await expect(
        readCodeEvidence(workspaceRoot, {
          path: 'src/math.ts',
          testSnapshotId: initial.snapshotId,
        }),
      ).resolves.toMatchObject({
        executionCoverage: unbound
          ? { state: 'unknown', reason: 'digest-unavailable' }
          : { state: 'observed', fileDigest: sha256Hex(originalSource) },
      });

      if (projects === 'cached') {
        const restored = await captureTestSnapshot(workspaceRoot, request);
        expect(restored.status).toBe('pass');
        await expect(
          readCodeEvidence(workspaceRoot, {
            path: 'src/math.ts',
            testSnapshotId: restored.snapshotId,
          }),
        ).resolves.toMatchObject({
          executionCoverage: { state: 'observed', fileDigest: sha256Hex(originalSource) },
        });
      }

      await writeFile(
        testPath,
        testSource.replace(
          'EDIT_SOURCE',
          `writeFileSync(${JSON.stringify(sourcePath)}, 'export function math() { return 2; }\\n');`,
        ),
      );
      const edited = await captureTestSnapshot(workspaceRoot, request);
      expect(edited.status).toBe('pass');
      expect(edited.freshness).toEqual(
        unbound
          ? { state: 'partial', changedPaths: [] }
          : { state: 'stale', changedPaths: ['src/math.ts'] },
      );
      await expect(
        readCodeEvidence(workspaceRoot, { path: 'src/math.ts', testSnapshotId: edited.snapshotId }),
      ).resolves.toMatchObject({
        executionCoverage: {
          state: 'unknown',
          reason: unbound ? 'digest-unavailable' : 'digest-mismatch',
          fileDigest: unbound ? undefined : sha256Hex(originalSource),
        },
      });
      if (projects === 'cached') {
        await writeFile(
          testPath,
          testSource.replace('EDIT_SOURCE', '').replace('toBe(1)', 'toBe(2)'),
        );
        const rebuilt = await captureTestSnapshot(workspaceRoot, request);
        expect(rebuilt.status).toBe('pass');
        await expect(
          readCodeEvidence(workspaceRoot, {
            path: 'src/math.ts',
            testSnapshotId: rebuilt.snapshotId,
          }),
        ).resolves.toMatchObject({
          executionCoverage: {
            state: 'observed',
            fileDigest: sha256Hex('export function math() { return 2; }\n'),
          },
        });
      }
    });
  },
  15_000,
);

test('leaves coverage unbound when compiled source bytes are absent or conflict', async () => {
  await withTempWorkspace('rstack-context-execution-', async (workspaceRoot) => {
    const sourcePath = path.join(workspaceRoot, 'source.ts');
    await writeFile(sourcePath, 'export const value = 2;');
    const coverage = {
      [sourcePath]: {
        path: sourcePath,
        statementMap: { '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 23 } } },
        fnMap: {},
        branchMap: {},
        s: { '0': 1 },
        f: {},
        b: {},
      },
    } as NonNullable<CapturedTestRunResult['coverage']>;
    const digests = new Map<string, string | undefined>();
    const observeSource = await createSourceObserver(createExecutionSourcePlugin(digests));
    const absent = normalizeExecutionFacet(workspaceRoot, workspaceRoot, {}, coverage, digests);
    expect(absent.files[0]?.digest).toBeUndefined();
    expect(absent.universe.completeness).toBe('partial');

    for (const value of [1, 2, 2]) {
      await observeSource(sourcePath, Buffer.from(`export const value = ${value};`));
    }
    const conflicting = normalizeExecutionFacet(
      workspaceRoot,
      workspaceRoot,
      {},
      coverage,
      digests,
    );
    expect(conflicting.files[0]?.digest).toBeUndefined();
    expect(conflicting.universe.completeness).toBe('partial');
    expect(conflicting.files[0]?.statements[0]?.hits).toBe(1);
  });
});
