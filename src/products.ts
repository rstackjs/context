import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ContractField,
  ContractTarget,
  ModuleRef,
  ObservedModule,
  ObservedModuleGraph,
  ProductRoot,
  ProductRootSet,
} from './analysisModel.ts';
import { isRecordObject } from './guards.ts';
import type { ContextDescriptor } from './model.ts';
import { compareStrings } from './order.ts';
import { normalizeModuleSelector } from './paths.ts';

const collectStringLeaves = (value: unknown, targets: string[]): void => {
  if (typeof value === 'string') {
    targets.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectStringLeaves(entry, targets);
  } else if (isRecordObject(value)) {
    for (const entry of Object.values(value)) collectStringLeaves(entry, targets);
  }
};

const readContractTargets = async (
  workspaceRoot: string,
  packageRoot: string,
): Promise<Array<{ field: ContractField; target: string }> | undefined> => {
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      await readFile(path.join(workspaceRoot, packageRoot, 'package.json'), 'utf8'),
    );
  } catch {
    return undefined;
  }
  if (!isRecordObject(manifest)) return undefined;

  const pairs: Array<{ field: ContractField; target: string }> = [];
  for (const field of ['exports', 'bin'] as const) {
    const targets: string[] = [];
    collectStringLeaves(manifest[field], targets);
    pairs.push(...targets.map((target) => ({ field, target })));
  }
  for (const field of ['main', 'module', 'types'] as const) {
    if (typeof manifest[field] === 'string') pairs.push({ field, target: manifest[field] });
  }

  const unique = new Map(pairs.map((pair) => [`${pair.field}\u0000${pair.target}`, pair]));
  return [...unique.values()].sort(
    (left, right) =>
      compareStrings(left.field, right.field) || compareStrings(left.target, right.target),
  );
};

const matchesTarget = (module: ObservedModule, target: string, packageRoot: string): boolean => {
  const modulePath = normalizeModuleSelector(module.path);
  const normalizedTarget = normalizeModuleSelector(target);
  if (modulePath.split('/').includes('node_modules')) return false;
  const normalizedPackageRoot = normalizeModuleSelector(packageRoot);
  const scopedTarget =
    normalizedPackageRoot === '.'
      ? normalizedTarget
      : normalizeModuleSelector(`${normalizedPackageRoot}/${normalizedTarget}`);
  return modulePath === scopedTarget || modulePath.endsWith(`/${scopedTarget}`);
};

const toModuleRef = ({
  isEntry: _,
  optimizerBound: __,
  optimizerReasons: ___,
  ...module
}: ObservedModule): ModuleRef => module;

const addRoot = (roots: ProductRoot[], root: ProductRoot): void => {
  if (roots.some(({ kind, module }) => kind === root.kind && module.id === root.module.id)) {
    return;
  }
  roots.push(root);
};

const resolveProductRoots = async (
  workspaceRoot: string,
  context: ContextDescriptor,
  graph: ObservedModuleGraph,
): Promise<ProductRootSet> => {
  if (context.product !== 'application' && context.product !== 'library') {
    throw new Error('Reachability requires an application or library context.');
  }

  const roots: ProductRoot[] = [];
  const bounds: string[] = [];
  const reportedEntries = graph.modules.filter(({ isEntry }) => isEntry);
  const entryPathById = new Map(
    reportedEntries.map(({ id, path: modulePath }) => [id, normalizeModuleSelector(modulePath)]),
  );
  const nestedEntryIds = new Set(
    graph.edges
      .filter(({ from, to }) => {
        const fromPath = entryPathById.get(from);
        return fromPath !== undefined && fromPath === entryPathById.get(to);
      })
      .map(({ to }) => to),
  );
  const entries = reportedEntries.filter(({ id }) => !nestedEntryIds.has(id));
  for (const module of entries) {
    addRoot(roots, {
      kind: 'production-entry',
      module: toModuleRef(module),
      label: `entry: ${module.name}`,
    });
  }
  if (entries.length === 0) bounds.push('no-production-entry-roots');

  let contractTargets: ContractTarget[] = [];
  if (context.product === 'library') {
    const targets = await readContractTargets(workspaceRoot, context.packageRoot);
    if (targets === undefined) {
      bounds.push('package-manifest-unavailable');
    } else {
      const modulesById = new Map(graph.modules.map((module) => [module.id, module]));
      contractTargets = targets.map(({ field, target }) => ({
        field,
        target,
        matchedModuleIds: graph.modules
          .filter((module) => matchesTarget(module, target, context.packageRoot))
          .map(({ id }) => id),
      }));
      for (const target of contractTargets) {
        if (target.matchedModuleIds.length === 0) {
          bounds.push(`unmapped-contract-target:${target.field}:${target.target}`);
          continue;
        }
        if (target.field === 'types') continue;
        for (const moduleId of target.matchedModuleIds) {
          const module = modulesById.get(moduleId)!;
          addRoot(roots, {
            kind: 'published-contract',
            module: toModuleRef(module),
            label: `package.json ${target.field}: ${target.target}`,
          });
        }
      }
    }
    bounds.push('published-library-open-world');
  }

  if (graph.exportRowsPresent) bounds.push('export-usage-schema-unsupported');
  bounds.push(...graph.issues);

  return {
    contextId: context.contextId,
    packageRoot: context.packageRoot,
    product: context.product,
    roots,
    contractTargets,
    bounds,
  };
};

export { resolveProductRoots, toModuleRef };
