import type { ObservedModuleGraph, ProductRootSet } from './analysisModel.ts';
import type { ContextDescriptor } from './model.ts';
import { resolveProductRoots } from './products.ts';

const resolveArtifactProductRoots = async (
  workspaceRoot: string,
  context: ContextDescriptor,
  graph: ObservedModuleGraph,
): Promise<ProductRootSet> => {
  if (context.product === 'application' || context.product === 'library') {
    return resolveProductRoots(workspaceRoot, context, graph);
  }

  const artifactRoots = await resolveProductRoots(
    workspaceRoot,
    { ...context, product: 'application' },
    graph,
  );
  return {
    ...artifactRoots,
    product: 'unknown',
    bounds: ['product-context-unavailable', ...artifactRoots.bounds],
  };
};

export { resolveArtifactProductRoots };
