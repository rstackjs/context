import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DeadCodeExplanation } from './analysisModel.ts';
import { sha256Hex } from './guards.ts';
import { diagnosticsFromStoredSnapshot, type DiagnosticRecord } from './lint.ts';
import type {
  ContextFreshness,
  ContextSnapshot,
  StoredContextSnapshot,
  TestExecutionFacet,
  TestExecutionLocation,
  TestFacet,
} from './model.ts';
import { normalizeModuleSelector, toWorkspacePath } from './paths.ts';
import { explainAnalysisModule, loadAnalysis } from './queries.ts';
import { assessSnapshotFreshness } from './source.ts';
import { readContextSnapshotById, readContextSnapshots } from './store.ts';

type CodeEvidenceQuery = {
  path: string;
  line?: number;
  contextId?: string;
  dataFile?: string;
  module?: string;
  testSnapshotId?: string;
  lintSnapshotId?: string;
  maxDepth?: number;
};

type SnapshotEvidence = {
  snapshotId: string;
  contextId: string;
  observedAt: string;
  status: ContextSnapshot['status'];
  completeness: ContextSnapshot['completeness'];
  freshness: ContextFreshness;
  packageRoot: string;
};

type ExecutionCoverageEvidence = {
  state: 'observed' | 'not-observed' | 'unknown' | 'unavailable';
  reason?:
    | 'no-test-snapshot'
    | 'not-captured'
    | 'provider-unavailable'
    | 'path-not-reported'
    | 'digest-unavailable'
    | 'digest-mismatch'
    | 'partial-universe'
    | 'no-overlapping-locations';
  relevantLocations: number;
  observedLocations: number;
  fileDigest?: string;
};

type TestOutcomeEvidence = {
  state: 'failed' | 'passed' | 'not-run' | 'unknown';
  basis?: 'exact-path' | 'related-selection';
  reason?: 'no-exact-test-record' | 'related-tests-not-reported';
  matchingFiles: number;
  matchingTests: number;
};

type TestRelationEvidence = {
  state: 'related' | 'unrelated' | 'unknown' | 'unavailable';
  reason?: 'no-test-snapshot' | 'not-captured' | 'source-not-selected' | 'selection-not-isolated';
  testFiles: string[];
};

type CodeDiagnosticEvidence = {
  total: number;
  returned: number;
  truncated: boolean;
  items: DiagnosticRecord[];
};

type CodeEvidenceResult = {
  path: string;
  line?: number;
  executionCoverage: ExecutionCoverageEvidence;
  testRelation: TestRelationEvidence;
  testOutcome: TestOutcomeEvidence;
  diagnostics: CodeDiagnosticEvidence;
  module?: DeadCodeExplanation;
  provenance: { test?: SnapshotEvidence; lint?: SnapshotEvidence };
  bounds: string[];
};

const normalizeSourcePath = (workspaceRoot: string, value: string): string => {
  const portable = value.replaceAll('\\', '/');
  if (portable.length === 0 || path.posix.isAbsolute(portable)) {
    throw new Error('path must be a non-empty checkout-relative source path.');
  }
  const normalized = normalizeModuleSelector(value);
  const relative = toWorkspacePath(workspaceRoot, normalized);
  if (relative.length === 0 || relative === '..' || relative.startsWith('../')) {
    throw new Error('path must be a non-empty checkout-relative source path.');
  }
  return relative;
};

const packageContainsPath = (packageRoot: string, sourcePath: string): boolean => {
  const normalizedRoot = path.posix.normalize(packageRoot.replaceAll('\\', '/'));
  return (
    normalizedRoot === '.' ||
    sourcePath === normalizedRoot ||
    sourcePath.startsWith(`${normalizedRoot}/`)
  );
};

const lintSnapshotCapturedPath = (
  stored: StoredContextSnapshot,
  sourcePath: string,
): boolean =>
  stored.snapshot.source?.inputs?.some((input) => input.path === sourcePath) === true ||
  diagnosticsFromStoredSnapshot(stored).some((diagnostic) => diagnostic.path === sourcePath);

const selectSnapshot = async (
  workspaceRoot: string,
  producer: 'rstest' | 'rslint',
  sourcePath: string,
  snapshotId: string | undefined,
): Promise<StoredContextSnapshot | undefined> => {
  if (snapshotId !== undefined) {
    const selected = await readContextSnapshotById(workspaceRoot, snapshotId);
    if (selected === undefined || selected.run.producer !== producer) {
      throw new Error(`${producer === 'rstest' ? 'Rstest' : 'Rslint'} snapshot not found.`);
    }
    if (!packageContainsPath(selected.context.packageRoot, sourcePath)) {
      throw new Error(
        `Selected ${producer === 'rstest' ? 'Rstest' : 'Rslint'} snapshot package root does not contain the source path.`,
      );
    }
    if (producer === 'rslint' && !lintSnapshotCapturedPath(selected, sourcePath)) {
      throw new Error('Selected Rslint snapshot did not capture the source path.');
    }
    return selected;
  }
  return (await readContextSnapshots(workspaceRoot, { producer })).find(
    (stored) =>
      packageContainsPath(stored.context.packageRoot, sourcePath) &&
      stored.snapshot.facets[producer === 'rstest' ? 'test' : 'lint'] !== undefined &&
      (producer !== 'rslint' || lintSnapshotCapturedPath(stored, sourcePath)),
  );
};

const snapshotEvidence = async (
  workspaceRoot: string,
  stored: StoredContextSnapshot,
): Promise<SnapshotEvidence> => ({
  snapshotId: stored.snapshot.snapshotId,
  contextId: stored.snapshot.contextId,
  observedAt: stored.snapshot.observedAt,
  status: stored.snapshot.status,
  completeness: stored.snapshot.completeness,
  freshness: await assessSnapshotFreshness(workspaceRoot, stored.snapshot),
  packageRoot: stored.context.packageRoot,
});

const locationOverlapsLine = (location: TestExecutionLocation, line: number | undefined): boolean =>
  line === undefined || (location.start.line <= line && location.end.line >= line);

const readCurrentDigest = async (
  workspaceRoot: string,
  sourcePath: string,
): Promise<string | undefined> => {
  try {
    return sha256Hex(await readFile(path.resolve(workspaceRoot, sourcePath)));
  } catch {
    return undefined;
  }
};

const executionCoverage = async (
  workspaceRoot: string,
  sourcePath: string,
  line: number | undefined,
  stored: StoredContextSnapshot | undefined,
): Promise<ExecutionCoverageEvidence> => {
  const empty = { relevantLocations: 0, observedLocations: 0 };
  if (stored === undefined) return { state: 'unavailable', reason: 'no-test-snapshot', ...empty };
  const facet = stored.snapshot.facets.execution as unknown as TestExecutionFacet | undefined;
  if (facet === undefined) return { state: 'unavailable', reason: 'not-captured', ...empty };
  if (facet.availability !== 'available') {
    return { state: 'unavailable', reason: 'provider-unavailable', ...empty };
  }
  const file = facet.files.find((entry) => entry.path === sourcePath);
  if (file === undefined) return { state: 'unknown', reason: 'path-not-reported', ...empty };
  const digest = await readCurrentDigest(workspaceRoot, sourcePath);
  if (digest === undefined || file.digest === undefined) {
    return { state: 'unknown', reason: 'digest-unavailable', fileDigest: file.digest, ...empty };
  }
  if (digest !== file.digest) {
    return { state: 'unknown', reason: 'digest-mismatch', fileDigest: file.digest, ...empty };
  }

  const hits = [
    ...file.statements
      .filter(({ location }) => locationOverlapsLine(location, line))
      .map(({ hits }) => hits),
    ...file.functions
      .filter(({ location }) => locationOverlapsLine(location, line))
      .map(({ hits }) => hits),
    ...file.branches.flatMap(({ arms }) =>
      arms.filter(({ location }) => locationOverlapsLine(location, line)).map(({ hits }) => hits),
    ),
  ];
  const observedLocations = hits.filter((value) => value > 0).length;
  const counts = { relevantLocations: hits.length, observedLocations, fileDigest: file.digest };
  if (hits.length === 0) {
    return { state: 'unknown', reason: 'no-overlapping-locations', ...counts };
  }
  if (observedLocations > 0) return { state: 'observed', ...counts };
  if (
    stored.snapshot.completeness.execution !== 'complete' ||
    facet.universe.completeness !== 'complete' ||
    facet.truncated.files > 0 ||
    facet.truncated.locations > 0
  ) {
    return { state: 'unknown', reason: 'partial-universe', ...counts };
  }
  return { state: 'not-observed', ...counts };
};

const testOutcome = (
  sourcePath: string,
  stored: StoredContextSnapshot | undefined,
): TestOutcomeEvidence => {
  if (stored === undefined) return { state: 'unknown', matchingFiles: 0, matchingTests: 0 };
  const facet = stored.snapshot.facets.test as unknown as TestFacet | undefined;
  if (facet === undefined) return { state: 'unknown', matchingFiles: 0, matchingTests: 0 };
  const files = facet.files.filter((file) => file.path === sourcePath);
  const tests = facet.files
    .flatMap((file) => file.tests)
    .filter((test) => test.path === sourcePath);
  let basis: TestOutcomeEvidence['basis'] = 'exact-path';
  let matchingFiles = files;
  let matchingTests = tests;
  if (files.length === 0 && tests.length === 0) {
    const relation = facet.relation;
    if (
      relation === undefined ||
      relation.sources.length !== 1 ||
      relation.sources[0] !== sourcePath
    ) {
      return {
        state: 'unknown',
        reason: 'no-exact-test-record',
        matchingFiles: 0,
        matchingTests: 0,
      };
    }
    const selectedPaths = new Set(relation.testFiles);
    matchingFiles = facet.files.filter((file) => selectedPaths.has(file.path));
    matchingTests = matchingFiles.flatMap((file) => file.tests);
    basis = 'related-selection';
    if (relation.testFiles.length > 0 && matchingFiles.length === 0) {
      return {
        state: 'unknown',
        basis,
        reason: 'related-tests-not-reported',
        matchingFiles: 0,
        matchingTests: 0,
      };
    }
  }
  if (
    // A run-level unhandled error is global to the snapshot, so it only attributes to this source
    // when the run was provably isolated to it. An exact test-file record reports its own outcome.
    (basis === 'related-selection' && facet.unhandledErrors.length > 0) ||
    matchingFiles.some((file) => file.status === 'fail' || (file.errors?.length ?? 0) > 0) ||
    matchingTests.some((test) => test.status === 'fail')
  ) {
    return {
      state: 'failed',
      basis,
      matchingFiles: matchingFiles.length,
      matchingTests: matchingTests.length,
    };
  }
  if (
    matchingFiles.some((file) => file.status === 'pass') ||
    matchingTests.some((test) => test.status === 'pass')
  ) {
    return {
      state: 'passed',
      basis,
      matchingFiles: matchingFiles.length,
      matchingTests: matchingTests.length,
    };
  }
  return {
    state: 'not-run',
    basis,
    matchingFiles: matchingFiles.length,
    matchingTests: matchingTests.length,
  };
};

const testRelation = (
  sourcePath: string,
  stored: StoredContextSnapshot | undefined,
): TestRelationEvidence => {
  if (stored === undefined) {
    return { state: 'unavailable', reason: 'no-test-snapshot', testFiles: [] };
  }
  const facet = stored.snapshot.facets.test as unknown as TestFacet | undefined;
  if (facet?.relation === undefined) {
    return { state: 'unavailable', reason: 'not-captured', testFiles: [] };
  }
  if (!facet.relation.sources.includes(sourcePath)) {
    return { state: 'unknown', reason: 'source-not-selected', testFiles: [] };
  }
  if (facet.relation.sources.length !== 1) {
    return {
      state: 'unknown',
      reason: 'selection-not-isolated',
      testFiles: [...facet.relation.testFiles],
    };
  }
  return {
    state: facet.relation.testFiles.length > 0 ? 'related' : 'unrelated',
    testFiles: [...facet.relation.testFiles],
  };
};

const compareDiagnostics = (left: DiagnosticRecord, right: DiagnosticRecord): number =>
  left.producer.localeCompare(right.producer) ||
  (left.line ?? 0) - (right.line ?? 0) ||
  (left.column ?? 0) - (right.column ?? 0) ||
  left.message.localeCompare(right.message);

const moduleEvidence = async (
  workspaceRoot: string,
  query: Required<Pick<CodeEvidenceQuery, 'contextId' | 'dataFile'>> &
    Pick<CodeEvidenceQuery, 'maxDepth' | 'module'> & { path: string },
): Promise<DeadCodeExplanation> => {
  // The Rsdoctor artifact is read and normalized once per call; every module axis below reuses it.
  const analysis = await loadAnalysis(workspaceRoot, query);
  if (query.module !== undefined) {
    return explainAnalysisModule(analysis, { module: query.module, maxDepth: query.maxDepth });
  }
  const { product } = analysis;
  const packageRelativePath =
    product.packageRoot === '.'
      ? query.path
      : query.path.startsWith(`${product.packageRoot}/`)
        ? query.path.slice(product.packageRoot.length + 1)
        : query.path;
  const insufficientEvidence = (): DeadCodeExplanation => ({
    provenance: analysis.provenance,
    classification: 'insufficient-evidence',
    state: {
      productionReachability: 'unknown',
      publicContract: 'unknown',
      shipped: 'unknown',
      optimizerRetention: 'unknown',
    },
    paths: [],
    evidence: ['No unique artifact module matched the exact source path.'],
    analysisTruncated: false,
    bounds: [...product.bounds, 'source-path-module-match-unavailable'],
  });
  try {
    return explainAnalysisModule(analysis, { module: query.path, maxDepth: query.maxDepth });
  } catch (error) {
    if (error instanceof Error && /^Ambiguous module selector:/u.test(error.message)) {
      return insufficientEvidence();
    }
    if (!(error instanceof Error) || !/^Unknown module selector:/u.test(error.message)) throw error;
    if (packageRelativePath !== query.path) {
      try {
        return explainAnalysisModule(analysis, {
          module: packageRelativePath,
          maxDepth: query.maxDepth,
        });
      } catch (fallbackError) {
        if (
          !(fallbackError instanceof Error) ||
          !/^(?:Unknown|Ambiguous) module selector:/u.test(fallbackError.message)
        ) {
          throw fallbackError;
        }
      }
    }
    return insufficientEvidence();
  }
};

const readCodeEvidence = async (
  workspaceRoot: string,
  query: CodeEvidenceQuery,
): Promise<CodeEvidenceResult> => {
  if ((query.contextId === undefined) !== (query.dataFile === undefined)) {
    throw new Error('contextId and dataFile must be supplied together.');
  }
  if (query.module !== undefined && query.contextId === undefined) {
    throw new Error('module requires contextId and dataFile.');
  }
  if (query.line !== undefined && (!Number.isInteger(query.line) || query.line < 1)) {
    throw new Error('line must be a positive integer.');
  }
  const sourcePath = normalizeSourcePath(workspaceRoot, query.path);
  const [testSnapshot, lintSnapshot] = await Promise.all([
    selectSnapshot(workspaceRoot, 'rstest', sourcePath, query.testSnapshotId),
    selectSnapshot(workspaceRoot, 'rslint', sourcePath, query.lintSnapshotId),
  ]);
  const matchingDiagnostics = [
    ...(lintSnapshot === undefined ? [] : diagnosticsFromStoredSnapshot(lintSnapshot)),
    ...(testSnapshot === undefined ? [] : diagnosticsFromStoredSnapshot(testSnapshot)),
  ]
    .filter((diagnostic) => diagnostic.path === sourcePath)
    .sort(compareDiagnostics);
  const diagnosticItems = matchingDiagnostics.slice(0, 200);
  const diagnostics: CodeDiagnosticEvidence = {
    total: matchingDiagnostics.length,
    returned: diagnosticItems.length,
    truncated: diagnosticItems.length < matchingDiagnostics.length,
    items: diagnosticItems,
  };
  const module =
    query.contextId === undefined || query.dataFile === undefined
      ? undefined
      : await moduleEvidence(workspaceRoot, {
          path: sourcePath,
          contextId: query.contextId,
          dataFile: query.dataFile,
          module: query.module,
          maxDepth: query.maxDepth,
        });
  const provenance = {
    ...(testSnapshot === undefined
      ? {}
      : { test: await snapshotEvidence(workspaceRoot, testSnapshot) }),
    ...(lintSnapshot === undefined
      ? {}
      : { lint: await snapshotEvidence(workspaceRoot, lintSnapshot) }),
  };
  const bounds = [
    'aggregate-execution-no-test-attribution',
    'test-relation-static-build-graph',
    'test-outcome-exact-path-or-isolated-related-selection',
    'diagnostics-exact-path-only',
    ...(module !== undefined && module.provenance.artifactBinding !== 'exact'
      ? ['artifact-binding-not-exact']
      : []),
  ];
  return {
    path: sourcePath,
    ...(query.line === undefined ? {} : { line: query.line }),
    executionCoverage: await executionCoverage(workspaceRoot, sourcePath, query.line, testSnapshot),
    testRelation: testRelation(sourcePath, testSnapshot),
    testOutcome: testOutcome(sourcePath, testSnapshot),
    diagnostics,
    ...(module === undefined ? {} : { module }),
    provenance,
    bounds,
  };
};

export { readCodeEvidence };
export type {
  CodeDiagnosticEvidence,
  CodeEvidenceQuery,
  CodeEvidenceResult,
  ExecutionCoverageEvidence,
  SnapshotEvidence,
  TestOutcomeEvidence,
  TestRelationEvidence,
};
