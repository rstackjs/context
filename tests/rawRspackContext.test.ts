import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@rstest/core';
import {
  contextStoreSchemaVersion,
  writeContextRunManifest,
  writeContextSnapshot,
  type ContextDescriptor,
  type ContextRunManifest,
  type ContextSnapshot,
} from '../src/index.ts';
import { readCodeEvidence } from '../src/codeEvidence.ts';
import { readProductRoots } from '../src/queries.ts';

const fixtureRoot = path.resolve(
  import.meta.dirname,
  '../fixtures/context/reachability/application',
);

test('uses raw artifact entry roots when only an Rstest context is available', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'rstack-raw-rspack-context-'));
  await cp(fixtureRoot, workspaceRoot, { recursive: true });

  try {
    const context = {
      contextId: 'ctx_test',
      packageRoot: '.',
      product: 'development',
      environment: 'test',
    } satisfies ContextDescriptor;
    const run = {
      schemaVersion: contextStoreSchemaVersion,
      runId: 'run_test',
      producer: 'rstest',
      command: 'test',
      startedAt: '2026-08-14T04:00:00.000Z',
      contexts: [context],
    } satisfies ContextRunManifest;
    const snapshot = {
      schemaVersion: contextStoreSchemaVersion,
      snapshotId: 'snap_test',
      runId: run.runId,
      contextId: context.contextId,
      sequence: 1,
      observedAt: '2026-08-14T04:00:01.000Z',
      status: 'pass',
      completeness: { test: 'complete' },
      facets: {
        test: {
          producer: 'rstest',
          files: [],
          stats: {
            tests: { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 },
            files: { total: 0, failed: 0 },
          },
          durationMs: 0,
          unhandledErrors: [],
        },
      },
    } satisfies ContextSnapshot;
    expect(await writeContextRunManifest(workspaceRoot, run)).toMatchObject({ written: true });
    expect(await writeContextSnapshot(workspaceRoot, snapshot)).toMatchObject({ written: true });

    const roots = await readProductRoots(workspaceRoot, {
      contextId: context.contextId,
      dataFile: 'rsdoctor-data.json',
    });
    expect(roots.product.product).toBe('unknown');
    expect(roots.product.roots.map(({ kind, module }) => [kind, module.id])).toContainEqual([
      'production-entry',
      '1',
    ]);
    expect(roots.product.bounds).toContain('product-context-unavailable');

    const evidence = await readCodeEvidence(workspaceRoot, {
      path: 'src/live.ts',
      contextId: context.contextId,
      dataFile: 'rsdoctor-data.json',
    });
    expect(evidence.module).toMatchObject({
      classification: 'reachable',
      state: { productionReachability: 'live', publicContract: 'unknown', shipped: 'yes' },
      bounds: expect.arrayContaining(['product-context-unavailable']),
    });
    expect(evidence.bounds).toContain('artifact-binding-not-exact');
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
});
