import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ConfigParams, RsbuildConfig } from '@rsbuild/core';
import { expect, test } from '@rstest/core';
import { createRstackContextPlugin } from '../src/rstack.ts';

type BuildConfig = { marker: string; plugins?: RsbuildConfig['plugins'] };
type Modifier = (
  config: BuildConfig,
  context: { params: ConfigParams },
) => BuildConfig | Promise<BuildConfig>;

const withTempWorkspace = async (
  callback: (workspaceRoot: string) => Promise<void>,
): Promise<void> => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'rstack-context-plugin-'));
  try {
    await writeFile(
      path.join(workspaceRoot, 'package.json'),
      JSON.stringify({ name: 'context-fixture', private: true }),
    );
    await callback(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
};

const setupPlugin = (
  plugin: ReturnType<typeof createRstackContextPlugin>,
): Map<'app' | 'lib', Modifier> => {
  const modifiers = new Map<'app' | 'lib', Modifier>();
  plugin.setup({
    modifyConfig(kind, handler) {
      modifiers.set(kind, handler as Modifier);
    },
  });
  return modifiers;
};

test('registers no build modifiers when Context capture is off', () => {
  const plugin = createRstackContextPlugin({
    config: { capture: 'off' },
    configDependencies: [],
    configFilePath: null,
    cwd: '/workspace',
  });

  expect(plugin.name).toBe('rstack:context');
  expect(setupPlugin(plugin).size).toBe(0);
});

test('appends independent application and library observers without mutating config', async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const configFilePath = path.join(workspaceRoot, 'rstack.config.ts');
    const dependencyPath = path.join(workspaceRoot, 'config', 'shared.ts');
    await mkdir(path.dirname(dependencyPath), { recursive: true });
    await writeFile(configFilePath, 'export {}');
    await writeFile(dependencyPath, 'export {}');

    const plugin = createRstackContextPlugin({
      config: { enabled: true, variant: 'fixture' },
      configDependencies: [dependencyPath],
      configFilePath,
      cwd: workspaceRoot,
    });
    const modifiers = setupPlugin(plugin);
    const existingPlugin = { name: 'existing', setup() {} };
    const config: BuildConfig = { marker: 'preserved', plugins: [existingPlugin] };
    const params = {
      command: 'build',
      env: 'production',
      envMode: 'production',
    } as ConfigParams;

    const application = await modifiers.get('app')!(config, { params });
    const library = await modifiers.get('lib')!(config, { params });

    expect([...modifiers.keys()]).toEqual(['app', 'lib']);
    expect(config.plugins).toEqual([existingPlugin]);
    expect(application).not.toBe(config);
    expect(library).not.toBe(config);
    expect(application).toMatchObject({ marker: 'preserved' });
    expect(library).toMatchObject({ marker: 'preserved' });
    expect(
      application.plugins?.map((entry) => (entry && 'name' in entry ? entry.name : entry)),
    ).toEqual(['existing', 'rstack:context-build']);
    expect(
      library.plugins?.map((entry) => (entry && 'name' in entry ? entry.name : entry)),
    ).toEqual(['existing', 'rstack:context-build']);
  });
});
