/* rslint-disable @typescript-eslint/no-unsafe-assignment -- Rstest asymmetric matchers are intentionally untyped. */
import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from '@rstest/core';
import { readContextWorkspaceStatus } from '../src/store.ts';
import type { BuildMetadataFacet } from '../src/model.ts';
import { withTempWorkspace } from './helpers.ts';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const rstackRoot = path.dirname(createRequire(import.meta.url).resolve('rstack/package.json'));

test.each(['application', 'library'] as const)(
  'captures a native Rstack %s build through define.extends',
  async (product) => {
    await withTempWorkspace('context-rstack-', async (temporaryRoot) => {
      const workspaceRoot = await realpath(temporaryRoot);
      const packageRoot = path.join(workspaceRoot, 'packages', product);
      const tool = product === 'application' ? 'app' : 'lib';
      await mkdir(path.join(workspaceRoot, 'node_modules', '@rstackjs'), { recursive: true });
      await symlink(
        repositoryRoot,
        path.join(workspaceRoot, 'node_modules', '@rstackjs', 'context'),
      );
      await symlink(rstackRoot, path.join(workspaceRoot, 'node_modules', 'rstack'));
      await writeFile(path.join(workspaceRoot, 'package.json'), '{"private":true}');
      await writeFile(path.join(workspaceRoot, 'pnpm-workspace.yaml'), 'packages: ["packages/*"]');
      await mkdir(path.join(packageRoot, 'src'), { recursive: true });
      await writeFile(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({ name: `fixture-${product}`, type: 'module' }),
      );
      await writeFile(
        path.join(packageRoot, 'src/index.ts'),
        'export const value = CONTEXT_VALUE; console.log(value);',
      );
      await writeFile(
        path.join(packageRoot, 'src/index.test.ts'),
        `import { test, expect } from 'rstack/test';
import { value } from './index';
test('inherits the selected build config', () => expect(value).toBe('local'));`,
      );
      await writeFile(
        path.join(packageRoot, 'rstack.config.ts'),
        `import { define } from 'rstack';
import { createRstackContextConfig } from '@rstackjs/context/shared-config';

define.${tool}({
  ${tool === 'lib' ? "lib: [{id: 'esm', format: 'esm'}, {id: 'cjs', format: 'cjs'}], dts: false," : ''}
  source: { entry: {index: './src/index.ts'}, define: {CONTEXT_VALUE: '"local"'} },
  output: {distPath: {root: 'out'}, minify: false},
});
define.extends([{extends: [createRstackContextConfig({products: '${product}', variant: 'integration'})],
  ${tool}: {source: {define: {CONTEXT_VALUE: '"shared"'}}},
  test: {include: ['src/*.test.ts'], testEnvironment: 'node'},
}]);`,
      );
      const command = tool === 'app' ? ['build'] : ['lib', 'build'];
      const options = {
        cwd: packageRoot,
        timeout: 30_000,
        env: { ...process.env, RSTACK_CONTEXT: '0' },
      };
      await execFileAsync(
        process.execPath,
        [path.join(rstackRoot, 'bin/rs.js'), ...command],
        options,
      );
      expect((await readContextWorkspaceStatus(workspaceRoot)).runs).toHaveLength(0);
      options.env.RSTACK_CONTEXT = '1';
      const build = await execFileAsync(
        process.execPath,
        [path.join(rstackRoot, 'bin/rs.js'), ...command],
        options,
      );
      expect(build.stderr).not.toContain('Failed to capture');
      const status = await readContextWorkspaceStatus(workspaceRoot);
      expect(status.runs).toHaveLength(1);
      const { run, contexts } = status.runs[0];
      expect(run.producer).toBe(tool === 'app' ? 'rsbuild' : 'rslib');
      expect(contexts).toHaveLength(tool === 'app' ? 1 : 2);
      for (const { context, latestSnapshot } of contexts) {
        expect(context).toMatchObject({
          product,
          packageRoot: `packages/${product}`,
          packageName: `fixture-${product}`,
          configPath: `packages/${product}/rstack.config.ts`,
          variant: 'integration',
        });
        expect(latestSnapshot).toMatchObject({
          status: 'pass',
          completeness: { build: 'complete' },
        });
      }
      for (const { context, latestSnapshot } of contexts) {
        const build = latestSnapshot!.facets.build as unknown as BuildMetadataFacet;
        const scripts = build.assets.filter((asset) => /\.(?:js|mjs|cjs)$/.test(asset.name));
        expect(scripts.length).toBeGreaterThan(0);
        for (const script of scripts) {
          expect(
            await readFile(path.join(workspaceRoot, context.distPath!, script.name), 'utf8'),
          ).toContain('local');
        }
        expect(latestSnapshot!.source?.inputs).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: `packages/${product}/rstack.config.ts` }),
          ]),
        );
      }
      await execFileAsync(
        process.execPath,
        [path.join(rstackRoot, 'bin/rs.js'), 'test', 'run'],
        options,
      );
    });
  },
  60_000,
);
