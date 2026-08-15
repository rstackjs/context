import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@rstest/core';

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
  peerDependencies?: Record<string, string>;
};

const repositoryRoot = path.resolve(import.meta.dirname, '..');

const readPackageJson = async (): Promise<PackageJson> =>
  JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')) as PackageJson;

test('publishes focused Context entry points without a Rstack dependency', async () => {
  const packageJson = await readPackageJson();

  expect(Object.keys(packageJson.exports ?? {}).sort()).toEqual([
    '.',
    './mcp',
    './package.json',
    './rsbuild',
    './rsdoctor',
    './rslib',
    './rslint',
    './rstack',
    './rstest',
  ]);
  // Commit-pinned canary of web-infra-dev/rsdoctor#1903: the dependency itself carries the
  // resolution so downstream installs get the build these tests certify (overrides do not
  // propagate). Swap for a release version once the PR merges and ships.
  expect(packageJson.dependencies?.['@rsdoctor/agent-cli']).toBe(
    'https://pkg.pr.new/@rsdoctor/agent-cli@ba5f0a83',
  );
  for (const section of [
    packageJson.dependencies,
    packageJson.devDependencies,
    packageJson.peerDependencies,
  ]) {
    expect(section?.rstack).toBeUndefined();
  }
});

test('loads each focused Context entry point independently', () => {
  const entryPoints = ['rsbuild', 'rslib', 'rstest', 'rslint', 'rsdoctor', 'mcp', 'rstack'];
  const script = `await Promise.all(${JSON.stringify(entryPoints)}.map((name) => import('@rstackjs/context/' + name)));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });

  expect(result.status, result.stderr).toBe(0);
});
