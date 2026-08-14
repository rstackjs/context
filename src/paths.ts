import path from 'node:path';

const toWorkspacePath = (workspaceRoot: string, filePath: string): string =>
  path.relative(workspaceRoot, path.resolve(workspaceRoot, filePath)).split(path.sep).join('/');

const normalizeModuleSelector = (value: string): string =>
  path.posix.normalize(value.replaceAll('\\', '/')).replace(/^\.\//u, '');

export { normalizeModuleSelector, toWorkspacePath };
