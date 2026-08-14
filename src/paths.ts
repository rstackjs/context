import path from 'node:path';

const toWorkspacePath = (workspaceRoot: string, filePath: string): string =>
  path.relative(workspaceRoot, path.resolve(workspaceRoot, filePath)).split(path.sep).join('/');

const normalizeModuleSelector = (value: string): string =>
  path.posix.normalize(value.replaceAll('\\', '/')).replace(/^\.\//u, '');

const resolveContainedPath = (workspaceRoot: string, field: string, value: string): string => {
  const portable = value.replaceAll('\\', '/');
  const resolved = path.resolve(workspaceRoot, value);
  const relative = path.relative(workspaceRoot, resolved);
  if (
    portable.length === 0 ||
    path.isAbsolute(value) ||
    path.posix.isAbsolute(portable) ||
    path.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error(
      `${field} must be a non-empty checkout-relative path that stays inside the checkout.`,
    );
  }
  return resolved;
};

export { normalizeModuleSelector, resolveContainedPath, toWorkspacePath };
