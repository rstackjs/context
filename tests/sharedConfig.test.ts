import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ConfigParams } from '@rsbuild/core';
import { expect, test } from '@rstest/core';
import { createRstackContextConfig } from '../src/sharedConfig.ts';
import { withTempWorkspace as withSharedTempWorkspace } from './helpers.ts';

const withTempWorkspace = async (
  callback: (workspaceRoot: string) => Promise<void>,
): Promise<void> =>
  withSharedTempWorkspace('rstack-context-config-', async (workspaceRoot) => {
    await writeFile(
      path.join(workspaceRoot, 'package.json'),
      JSON.stringify({ name: 'context-fixture', private: true }),
    );
    await callback(workspaceRoot);
  });

test('returns no shared config layers when Context capture is off', () => {
  expect(
    createRstackContextConfig({
      capture: 'off',
      products: ['application', 'library'],
    }),
  ).toEqual({});
});

test('requires the consumer to select at least one product', () => {
  expect(() =>
    createRstackContextConfig({
      products: [],
    }),
  ).toThrow('Rstack Context products must contain');
});

test('rejects unsupported products at the JavaScript boundary', () => {
  expect(() =>
    createRstackContextConfig({
      products: ['application', 'website'] as never,
    }),
  ).toThrow('Rstack Context products must contain');
});

test('defines only the selected product to preserve Rstest inheritance', () => {
  expect(
    Object.keys(
      createRstackContextConfig({
        products: 'application',
      }),
    ),
  ).toEqual(['app']);
  expect(
    Object.keys(
      createRstackContextConfig({
        products: 'library',
      }),
    ),
  ).toEqual(['lib']);
});

test('creates independent application and library shared config layers', async () => {
  await withTempWorkspace(async () => {
    const sharedConfig = createRstackContextConfig({
      products: ['application', 'library'],
      variant: 'fixture',
    });
    const params = {
      command: 'build',
      env: 'production',
      envMode: 'production',
    } as ConfigParams;

    const application = await sharedConfig.app!(params);
    const library = await sharedConfig.lib!(params);

    expect(application.plugins).toEqual([
      expect.objectContaining({ name: 'rstack:context-build' }),
    ]);
    expect(library.plugins).toEqual([expect.objectContaining({ name: 'rstack:context-build' })]);
  });
});
