/* rslint-disable @typescript-eslint/no-unsafe-assignment -- Rstest asymmetric matchers are intentionally untyped. */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@rstest/core';
import {
  contextStoreSchemaVersion,
  readProjectStatus,
  writeContextRunManifest,
  writeContextSnapshot,
  type ContextDescriptor,
  type ContextRunManifest,
  type ContextSnapshot,
} from '../src/index.ts';
import { withTempWorkspace } from './helpers.ts';

const createRun = (
  runId: string,
  producer: ContextRunManifest['producer'],
  startedAt: string,
  context: ContextDescriptor,
): ContextRunManifest => ({
  schemaVersion: contextStoreSchemaVersion,
  runId,
  producer,
  command: 'build',
  startedAt,
  contexts: [context],
});

test('returns a stable anonymous status for an empty standalone store', async () => {
  await withTempWorkspace('rstack-context-status-', async (workspaceRoot) => {
    const status = await readProjectStatus(workspaceRoot);

    expect(status).toEqual({
      schemaVersion: contextStoreSchemaVersion,
      workspaceId: expect.stringMatching(/^ws_[0-9a-f]{24}$/u),
      contexts: [],
      issues: [],
    });
    expect(JSON.stringify(status)).not.toContain(workspaceRoot);
  });
});

test('keeps the newest completed snapshot when a later run recorded none', async () => {
  await withTempWorkspace('rstack-context-status-', async (workspaceRoot) => {
    await mkdir(path.join(workspaceRoot, 'packages', 'app'), { recursive: true });
    const appContext = {
      contextId: 'ctx_app',
      packageRoot: 'packages/app',
      product: 'application',
      environment: 'web',
    } as const;
    const goodRun = createRun('run_good', 'rsbuild', '2026-08-12T04:00:00.000Z', appContext);
    const abortedRun = createRun('run_aborted', 'rsbuild', '2026-08-12T06:00:00.000Z', appContext);
    const goodSnapshot = {
      schemaVersion: contextStoreSchemaVersion,
      snapshotId: 'snap_good',
      runId: goodRun.runId,
      contextId: appContext.contextId,
      sequence: 1,
      observedAt: '2026-08-12T04:00:01.000Z',
      status: 'pass',
      completeness: { build: 'complete' },
      facets: { summary: { errors: 0 } },
    } satisfies ContextSnapshot;

    expect(await writeContextRunManifest(workspaceRoot, goodRun)).toMatchObject({ written: true });
    expect(await writeContextSnapshot(workspaceRoot, goodSnapshot)).toMatchObject({
      written: true,
    });
    // An aborted build writes its run manifest at onBeforeBuild and never publishes a snapshot.
    expect(await writeContextRunManifest(workspaceRoot, abortedRun)).toMatchObject({
      written: true,
    });

    const masked = await readProjectStatus(workspaceRoot);

    expect(masked.contexts).toEqual([
      {
        runId: abortedRun.runId,
        producer: abortedRun.producer,
        context: appContext,
        state: 'ready',
        latestSnapshot: goodSnapshot,
        freshness: { state: 'unknown', changedPaths: [] },
      },
    ]);

    const laterRun = createRun('run_later', 'rsbuild', '2026-08-12T07:00:00.000Z', appContext);
    const laterSnapshot = {
      ...goodSnapshot,
      snapshotId: 'snap_later',
      runId: laterRun.runId,
      observedAt: '2026-08-12T07:00:01.000Z',
    } satisfies ContextSnapshot;
    expect(await writeContextRunManifest(workspaceRoot, laterRun)).toMatchObject({ written: true });
    expect(await writeContextSnapshot(workspaceRoot, laterSnapshot)).toMatchObject({
      written: true,
    });

    const refreshed = await readProjectStatus(workspaceRoot);

    expect(refreshed.contexts).toEqual([
      {
        runId: laterRun.runId,
        producer: laterRun.producer,
        context: appContext,
        state: 'ready',
        latestSnapshot: laterSnapshot,
        freshness: { state: 'unknown', changedPaths: [] },
      },
    ]);
  });
});

test('keeps complete status evidence while exposing a newer incomplete attempt', async () => {
  await withTempWorkspace('rstack-context-status-', async (workspaceRoot) => {
    const context = {
      contextId: 'ctx_test',
      packageRoot: '.',
      product: 'development',
      environment: 'test',
    } as const;
    const completeRun = createRun('run_complete', 'rstest', '2026-08-12T04:00:00.000Z', context);
    const errorRun = createRun('run_error', 'rstest', '2026-08-12T05:00:00.000Z', context);
    const completeSnapshot = {
      schemaVersion: contextStoreSchemaVersion,
      snapshotId: 'snap_complete',
      runId: completeRun.runId,
      contextId: context.contextId,
      sequence: 0,
      observedAt: '2026-08-12T04:00:01.000Z',
      status: 'pass',
      completeness: { test: 'complete' },
      facets: { summary: { tests: 1, failedTests: 0 } },
    } satisfies ContextSnapshot;
    const errorSnapshot = {
      ...completeSnapshot,
      snapshotId: 'snap_error',
      runId: errorRun.runId,
      observedAt: '2026-08-12T05:00:01.000Z',
      status: 'error',
      completeness: { test: 'partial', source: 'partial' },
      facets: { summary: { tests: 1, failedTests: 0, errors: 1 } },
      source: {
        inputs: [],
        inputCompleteness: 'partial',
        unreadableInputs: ['src/missing.ts'],
      },
    } satisfies ContextSnapshot;

    expect(await writeContextRunManifest(workspaceRoot, completeRun)).toMatchObject({
      written: true,
    });
    expect(await writeContextSnapshot(workspaceRoot, completeSnapshot)).toMatchObject({
      written: true,
    });
    expect(await writeContextRunManifest(workspaceRoot, errorRun)).toMatchObject({ written: true });
    expect(await writeContextSnapshot(workspaceRoot, errorSnapshot)).toMatchObject({
      written: true,
    });

    await expect(readProjectStatus(workspaceRoot)).resolves.toMatchObject({
      contexts: [
        {
          runId: errorRun.runId,
          producer: 'rstest',
          context,
          state: 'ready',
          latestSnapshot: completeSnapshot,
          latestAttempt: errorSnapshot,
          freshness: { state: 'unknown', changedPaths: [] },
        },
      ],
      issues: [],
    });
  });
});

test('projects only the latest run for each context in deterministic order', async () => {
  await withTempWorkspace('rstack-context-status-', async (workspaceRoot) => {
    await mkdir(path.join(workspaceRoot, 'packages', 'app'), {
      recursive: true,
    });
    await mkdir(path.join(workspaceRoot, 'packages', 'library'), {
      recursive: true,
    });

    const appContext = {
      contextId: 'ctx_app',
      packageRoot: 'packages/app',
      product: 'application',
      environment: 'web',
    } as const;
    const libraryContext = {
      contextId: 'ctx_library',
      packageRoot: 'packages/library',
      product: 'library',
      environment: 'esm',
    } as const;
    const firstAppRun = createRun('run_app_a', 'rsbuild', '2026-08-12T04:00:00.000Z', appContext);
    const secondAppRun = createRun('run_app_b', 'rsbuild', '2026-08-12T06:00:00.000Z', appContext);
    const firstLibraryRun = createRun(
      'run_library_a',
      'rslib',
      '2026-08-12T05:00:00.000Z',
      libraryContext,
    );
    const secondLibraryRun = createRun(
      'run_library_b',
      'rslib',
      '2026-08-12T05:00:00.000Z',
      libraryContext,
    );
    const appSnapshot = {
      schemaVersion: contextStoreSchemaVersion,
      snapshotId: 'snap_app_a',
      runId: firstAppRun.runId,
      contextId: appContext.contextId,
      sequence: 1,
      observedAt: '2026-08-12T04:00:01.000Z',
      status: 'pass',
      completeness: { build: 'complete' },
      facets: { summary: { errors: 0 } },
    } satisfies ContextSnapshot;
    const librarySnapshot = {
      schemaVersion: contextStoreSchemaVersion,
      snapshotId: 'snap_library_b',
      runId: secondLibraryRun.runId,
      contextId: libraryContext.contextId,
      sequence: 1,
      observedAt: '2026-08-12T05:00:01.000Z',
      status: 'pass',
      completeness: { build: 'complete' },
      facets: { summary: { errors: 0 } },
    } satisfies ContextSnapshot;

    expect(await writeContextRunManifest(workspaceRoot, firstAppRun)).toMatchObject({
      written: true,
    });
    expect(await writeContextRunManifest(workspaceRoot, firstLibraryRun)).toMatchObject({
      written: true,
    });
    expect(await writeContextRunManifest(workspaceRoot, secondLibraryRun)).toMatchObject({
      written: true,
    });
    expect(await writeContextRunManifest(workspaceRoot, secondAppRun)).toMatchObject({
      written: true,
    });
    expect(await writeContextSnapshot(workspaceRoot, appSnapshot)).toMatchObject({
      written: true,
    });
    expect(await writeContextSnapshot(workspaceRoot, librarySnapshot)).toMatchObject({
      written: true,
    });

    const status = await readProjectStatus(workspaceRoot);

    expect(status.contexts).toEqual([
      {
        runId: secondAppRun.runId,
        producer: secondAppRun.producer,
        context: appContext,
        state: 'ready',
        latestSnapshot: appSnapshot,
        freshness: { state: 'unknown', changedPaths: [] },
      },
      {
        runId: secondLibraryRun.runId,
        producer: secondLibraryRun.producer,
        context: libraryContext,
        state: 'ready',
        latestSnapshot: librarySnapshot,
        freshness: { state: 'unknown', changedPaths: [] },
      },
    ]);
    expect(JSON.stringify(status)).not.toContain(workspaceRoot);
  });
});
