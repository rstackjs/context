import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  createRstest,
  type CreateRstestOptions,
  type ListedTest,
  type RstestInstance,
  type RunOptions,
  type TestRunResult as NativeTestRunResult,
} from '@rstest/core/api';
import type { loadConfig as loadRstestConfig } from '@rstest/core';
import {
  contextStoreSchemaVersion,
  type ContextFreshness,
  type ContextRunStatus,
  type ContextSnapshot,
  type JsonValue,
  type TestCaseRecord,
  type TestErrorRecord,
  type TestExecutionFacet,
  type TestFacet,
  type TestFileRecord,
} from './model.ts';
import {
  createExecutionSourcePlugin,
  normalizeExecutionFacet,
  unavailableExecutionFacet,
  validateExecutionRequest,
  type TestExecutionRequest,
} from './execution.ts';
import { isRecordObject } from './guards.ts';
import { decodeCursor, encodeCursor } from './pagination.ts';
import { toWorkspacePath } from './paths.ts';
import {
  assessSnapshotFreshness,
  collectContextInputFiles,
  createExplicitContextDescriptor,
  createExplicitRun,
  resolveExplicitCaptureTarget,
} from './source.ts';
import {
  readContextSnapshotById,
  readContextSnapshots,
  writeContextRunManifest,
  writeContextSnapshot,
} from './store.ts';

type TestSnapshotRequest = {
  files?: string[];
  related?: string[];
  testNamePattern?: string;
  packageRoot?: string;
  configPath?: string;
  execution?: TestExecutionRequest;
};

type TestResultsQuery = {
  snapshotId?: string;
  project?: string;
  pathPrefix?: string;
  status?: TestCaseRecord['status'];
  limit?: number;
  cursor?: string;
};

type TestResultPage = {
  producer: 'rstest';
  contextId: string;
  snapshotId: string;
  observedAt: string;
  completeness: ContextSnapshot['completeness'];
  freshness: ContextFreshness;
  total: number;
  items: TestCaseRecord[];
  nextCursor?: string;
};

type TestCaptureResult = {
  runId: string;
  contextId: string;
  snapshotId: string;
  status: ContextRunStatus;
  freshness: ContextFreshness;
  summary: Record<string, number>;
  execution?: {
    provider: TestExecutionFacet['provider'];
    availability: TestExecutionFacet['availability'];
    completeness: TestExecutionFacet['universe']['completeness'];
  };
  errors?: TestCaptureError[];
  unhandledErrors?: TestErrorRecord[];
  unreadableInputs?: string[];
};

type RelatedTestSelection = {
  producer: 'rstest';
  packageRoot: string;
  sources: string[];
  testFiles: string[];
  total: number;
};

type TestCaptureError = TestErrorRecord & {
  scope: 'file' | 'run';
  project?: string;
  path?: string;
};

type CapturedTestError = NativeTestRunResult['unhandledErrors'][number] & {
  cause?: CapturedTestError;
};

type CapturedTestCase = Omit<
  NativeTestRunResult['testResults'][number],
  'errors' | 'retryErrors' | 'testId'
> & {
  testId?: string;
  errors?: CapturedTestError[];
  retryErrors?: CapturedTestError[];
};

type CapturedTestFile = CapturedTestCase & {
  results: CapturedTestCase[];
};

type CapturedTestRunResult = {
  ok: boolean;
  files: CapturedTestFile[];
  stats: NativeTestRunResult['summary'];
  unhandledErrors: CapturedTestError[];
  duration: { total: number };
  snapshot?: NativeTestRunResult['snapshotSummary'];
  coverage?: NativeTestRunResult['coverage'];
};

type RstestRuntime = Pick<RstestInstance, 'listTests' | 'run'>;
type CreateRstestRuntime = (options?: CreateRstestOptions) => Promise<RstestRuntime>;
type LoadRstestConfig = typeof loadRstestConfig;

type TestCaptureDependencies = {
  createRstest?: CreateRstestRuntime;
  loadConfig?: LoadRstestConfig;
  createRunId?: () => string;
  createSnapshotId?: () => string;
  now?: () => Date;
  hasCoverageProvider?: (packageRoot: string) => boolean | Promise<boolean>;
};

const optionalString = <K extends keyof TestErrorRecord>(
  key: K,
  value: TestErrorRecord[K] | undefined,
): Pick<TestErrorRecord, K> | Record<string, never> =>
  value === undefined ? {} : ({ [key]: value } as Pick<TestErrorRecord, K>);

// Rstest serializes `cause` chains recursively with its own cycle detection, but the depth is
// still attacker/author controlled, so capture truncates rather than trusting the producer.
const maxErrorCauseDepth = 8;

const normalizeError = (error: CapturedTestError, depth = 0): TestErrorRecord => ({
  name: error.name ?? 'Error',
  message: error.message,
  ...optionalString('stack', error.stack),
  ...optionalString('diff', error.diff),
  ...optionalString('actual', error.actual),
  ...optionalString('expected', error.expected),
  ...(error.retryCount === undefined ? {} : { retryCount: error.retryCount }),
  ...(error.cause === undefined || depth >= maxErrorCauseDepth
    ? {}
    : { cause: normalizeError(error.cause, depth + 1) }),
});

const normalizeErrors = (errors: ReadonlyArray<CapturedTestError>): TestErrorRecord[] =>
  errors.map((error) => normalizeError(error));

const maxMetaDepth = 8;

const normalizeMetaValue = (value: unknown, depth: number): JsonValue | undefined => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (depth >= maxMetaDepth) return undefined;
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const entry of value) {
      const item = normalizeMetaValue(entry, depth + 1);
      if (item === undefined) return undefined;
      items.push(item);
    }
    return items;
  }
  if (!isRecordObject(value)) return undefined;
  const record: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
    const entry = normalizeMetaValue(value[key], depth + 1);
    if (entry === undefined) return undefined;
    record[key] = entry;
  }
  return record;
};

const optionalTestMeta = (value: unknown): Pick<TestCaseRecord, 'meta'> | Record<string, never> => {
  if (!isRecordObject(value) || Object.keys(value).length === 0) return {};
  const normalized = normalizeMetaValue(value, 0);
  return isRecordObject(normalized) ? { meta: normalized as Record<string, JsonValue> } : {};
};

const compareTestCases = (left: TestCaseRecord, right: TestCaseRecord): number =>
  left.project.localeCompare(right.project) ||
  left.path.localeCompare(right.path) ||
  (left.parentNames ?? []).join('\u0000').localeCompare((right.parentNames ?? []).join('\u0000')) ||
  left.name.localeCompare(right.name);

const normalizeTestCase = (
  workspaceRoot: string,
  result: CapturedTestRunResult['files'][number]['results'][number],
): TestCaseRecord => ({
  project: result.project,
  path: toWorkspacePath(workspaceRoot, result.testPath),
  name: result.name,
  ...(result.parentNames === undefined ? {} : { parentNames: [...result.parentNames] }),
  status: result.status,
  ...(result.duration === undefined ? {} : { durationMs: result.duration }),
  ...(result.errors === undefined ? {} : { errors: normalizeErrors(result.errors) }),
  ...(result.retryErrors === undefined ? {} : { retryErrors: normalizeErrors(result.retryErrors) }),
  ...(result.retryCount === undefined ? {} : { retryCount: result.retryCount }),
  ...optionalTestMeta(result.meta),
});

const normalizeTestFile = (
  workspaceRoot: string,
  result: CapturedTestRunResult['files'][number],
): TestFileRecord => ({
  project: result.project,
  path: toWorkspacePath(workspaceRoot, result.testPath),
  status: result.status,
  ...(result.duration === undefined ? {} : { durationMs: result.duration }),
  ...(result.errors === undefined ? {} : { errors: normalizeErrors(result.errors) }),
  tests: result.results
    .map((testResult) => normalizeTestCase(workspaceRoot, testResult))
    .sort(compareTestCases),
});

const normalizeTestFacet = (
  workspaceRoot: string,
  result: CapturedTestRunResult,
  relation?: TestFacet['relation'],
): TestFacet => ({
  producer: 'rstest',
  ...(relation === undefined ? {} : { relation }),
  files: result.files
    .map((fileResult) => normalizeTestFile(workspaceRoot, fileResult))
    .sort(
      (left, right) =>
        left.project.localeCompare(right.project) || left.path.localeCompare(right.path),
    ),
  stats: {
    tests: { ...result.stats.tests },
    files: { ...result.stats.files },
  },
  durationMs: result.duration.total,
  unhandledErrors: normalizeErrors(result.unhandledErrors),
});

const testCaptureSelection = (request: TestSnapshotRequest): JsonValue => ({
  ...(request.files === undefined
    ? {}
    : { files: [...new Set(request.files)].sort((left, right) => left.localeCompare(right)) }),
  ...(request.related === undefined
    ? {}
    : { related: [...new Set(request.related)].sort((left, right) => left.localeCompare(right)) }),
  ...(request.testNamePattern === undefined ? {} : { testNamePattern: request.testNamePattern }),
});

const getRunStatus = (result: CapturedTestRunResult): ContextRunStatus => {
  if (result.unhandledErrors.length > 0) return 'error';
  return result.ok ? 'pass' : 'fail';
};

const ensureWritten = (result: Awaited<ReturnType<typeof writeContextSnapshot>>): void => {
  if (!result.written) throw result.error;
};

const normalizeNativeTestRun = (result: NativeTestRunResult): CapturedTestRunResult => ({
  ok: result.status === 'pass',
  files: result.results,
  stats: result.summary,
  unhandledErrors: result.unhandledErrors,
  duration: { total: result.duration.totalTime },
  snapshot: result.snapshotSummary,
  ...(result.coverage === undefined ? {} : { coverage: result.coverage }),
});

const createRstestNotConfiguredError = (workspaceRoot: string, packageRoot: string): Error => {
  const relativePackageRoot = toWorkspacePath(workspaceRoot, packageRoot) || '.';
  return new Error(
    `Rstest is not configured for package root "${relativePackageRoot}". Add a native rstest.config.* file supported by Rstest, or pass configPath.`,
  );
};

const loadNativeRstestConfig = async (
  workspaceRoot: string,
  packageRoot: string,
  configPath: string | undefined,
  loadConfig?: LoadRstestConfig,
): Promise<Awaited<ReturnType<(typeof import('@rstest/core'))['loadConfig']>>> => {
  const loader =
    loadConfig ??
    (await (async () => {
      const moduleName = '@rstest/core';
      return (await import(moduleName)).loadConfig;
    })());
  const config = await loader({
    cwd: packageRoot,
    ...(configPath === undefined ? {} : { path: configPath }),
  });
  if (config.filePath === null) {
    throw createRstestNotConfiguredError(workspaceRoot, packageRoot);
  }
  return config;
};

const createNativeRstest = async (
  workspaceRoot: string,
  packageRoot: string,
  configPath: string | undefined,
  factory: CreateRstestRuntime = createRstest,
  loadConfig?: LoadRstestConfig,
  sourceDigests?: Map<string, string | undefined>,
): Promise<{ configPath: string; runtime: RstestRuntime }> => {
  const config = await loadNativeRstestConfig(workspaceRoot, packageRoot, configPath, loadConfig);
  // File/glob projects are loaded internally by Rstest and cannot receive this observer.
  // Do not bind aggregate coverage using only a subset of the participating projects.
  if (
    sourceDigests !== undefined &&
    !config.content.projects?.some((project) => typeof project === 'string')
  ) {
    const plugin = createExecutionSourcePlugin(sourceDigests);
    config.content = {
      ...config.content,
      plugins: [...(config.content.plugins ?? []), plugin],
      ...(config.content.projects === undefined
        ? {}
        : {
            projects: config.content.projects.map((project) =>
              typeof project === 'string'
                ? project
                : { ...project, plugins: [...(project.plugins ?? []), plugin] },
            ),
          }),
    };
  }
  return {
    configPath: config.filePath!,
    runtime: await factory({ cwd: packageRoot, config }),
  };
};

const relatedTestFiles = (tests: ListedTest[]): string[] => [
  ...new Set(tests.map(({ testPath }) => testPath)),
];

const listRelatedTests = async (
  workspaceRoot: string,
  request: Pick<TestSnapshotRequest, 'packageRoot' | 'configPath'> & {
    related: string[];
  },
  factory?: CreateRstestRuntime,
): Promise<RelatedTestSelection> => {
  validateRelatedSelection(request);
  const target = await resolveExplicitCaptureTarget(workspaceRoot, request);
  const { runtime } = await createNativeRstest(
    workspaceRoot,
    target.packageRoot,
    target.configPath,
    factory,
  );
  const sources = [
    ...new Set(request.related.map((source) => path.resolve(target.packageRoot, source))),
  ];
  const testFiles = relatedTestFiles(
    await runtime.listTests({
      filesOnly: true,
      filters: sources,
      related: true,
    }),
  );
  const packageRoot = toWorkspacePath(workspaceRoot, target.packageRoot) || '.';
  return {
    producer: 'rstest',
    packageRoot,
    sources: sources.map((source) => toWorkspacePath(workspaceRoot, source)).sort(),
    testFiles: testFiles.map((file) => toWorkspacePath(workspaceRoot, file)).sort(),
    total: testFiles.length,
  };
};

const loadCoverageProviderLoader = async (): Promise<
  typeof import('@rstest/core/internal/browser').loadCoverageProvider
> => (await import('@rstest/core/internal/browser')).loadCoverageProvider;

const hasCoverageProvider = async (packageRoot: string): Promise<boolean> => {
  try {
    const loadCoverageProvider = await loadCoverageProviderLoader();
    await loadCoverageProvider({ provider: 'istanbul' }, packageRoot);
    return true;
  } catch {
    return false;
  }
};

const validateRelatedSelection = (request: TestSnapshotRequest): void => {
  if (request.files !== undefined && request.related !== undefined) {
    throw new Error('files and related cannot be used together.');
  }
  if (
    request.related !== undefined &&
    (request.related.length === 0 ||
      request.related.length > 200 ||
      request.related.some((source) => source.length === 0))
  ) {
    throw new Error('related must contain from 1 to 200 non-empty source paths.');
  }
};

const emptyTestRunResult = (): CapturedTestRunResult => ({
  ok: true,
  files: [],
  stats: {
    tests: { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 },
    files: { total: 0, failed: 0 },
  },
  unhandledErrors: [],
  duration: { total: 0 },
});

const captureTestSnapshot = async (
  workspaceRoot: string,
  request: TestSnapshotRequest,
  dependencies: TestCaptureDependencies = {},
): Promise<TestCaptureResult> => {
  validateExecutionRequest(request.execution);
  validateRelatedSelection(request);
  const target = await resolveExplicitCaptureTarget(workspaceRoot, request);
  const sourceDigests = new Map<string, string | undefined>();
  const { configPath, runtime } = await createNativeRstest(
    workspaceRoot,
    target.packageRoot,
    target.configPath,
    dependencies.createRstest,
    dependencies.loadConfig,
    request.execution === undefined ? undefined : sourceDigests,
  );
  const execution = request.execution;
  const captureExecution =
    execution !== undefined &&
    (await (dependencies.hasCoverageProvider ?? hasCoverageProvider)(target.packageRoot));
  const context = createExplicitContextDescriptor({
    producer: 'rstest',
    workspaceRoot,
    ...target,
    configPath,
  });
  const captureSelection = testCaptureSelection(request);
  const now = dependencies.now ?? (() => new Date());
  const run = createExplicitRun({
    producer: 'rstest',
    command: 'test',
    context,
    createRunId: dependencies.createRunId,
    now,
  });
  ensureWritten(await writeContextRunManifest(workspaceRoot, run));
  let result: CapturedTestRunResult | undefined;
  let relation: TestFacet['relation'];
  try {
    let selectedFiles = request.files;
    if (request.related !== undefined) {
      const sourceFiles = [
        ...new Set(request.related.map((source) => path.resolve(target.packageRoot, source))),
      ];
      const testFiles = relatedTestFiles(
        await runtime.listTests({
          filesOnly: true,
          filters: sourceFiles,
          related: true,
        }),
      );
      relation = {
        sources: sourceFiles.map((source) => toWorkspacePath(workspaceRoot, source)).sort(),
        testFiles: testFiles.map((file) => toWorkspacePath(workspaceRoot, file)).sort(),
      };
      selectedFiles = testFiles.map((file) => toWorkspacePath(target.packageRoot, file));
      if (selectedFiles.length === 0) result = emptyTestRunResult();
    }

    if (result === undefined) {
      const runOptions: RunOptions = {
        ...(request.related === undefined
          ? selectedFiles === undefined
            ? {}
            : { filters: selectedFiles }
          : {
              filters: request.related.map((source) => path.resolve(target.packageRoot, source)),
              related: true,
            }),
        ...(request.testNamePattern === undefined
          ? {}
          : { testNamePattern: request.testNamePattern }),
        ...(execution === undefined || !captureExecution
          ? {}
          : {
              coverage: {
                enabled: true,
                provider: 'istanbul',
                reporters: [],
                reportOnFailure: true,
                ...(execution.include === undefined ? {} : { include: execution.include }),
                ...(execution.exclude === undefined ? {} : { exclude: execution.exclude }),
                allowExternal: execution.allowExternal ?? false,
              },
            }),
      };
      result = normalizeNativeTestRun(await runtime.run(runOptions));
    }
  } catch (error) {
    const capturedError: TestErrorRecord =
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            ...optionalString('stack', error.stack),
          }
        : { name: 'Error', message: String(error) };
    const facet: TestFacet = {
      producer: 'rstest',
      files: [],
      stats: {
        tests: { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 },
        files: { total: 0, failed: 0 },
      },
      durationMs: 0,
      unhandledErrors: [capturedError],
    };
    const executionFacet =
      request.execution === undefined ? undefined : unavailableExecutionFacet(request.execution);
    const snapshot: ContextSnapshot = {
      schemaVersion: contextStoreSchemaVersion,
      snapshotId: dependencies.createSnapshotId?.() ?? `snap_${Date.now()}_${randomUUID()}`,
      runId: run.runId,
      contextId: context.contextId,
      sequence: 0,
      observedAt: now().toISOString(),
      status: 'error',
      completeness: {
        test: 'partial',
        ...(executionFacet === undefined ? {} : { execution: 'partial' }),
      },
      facets: {
        test: facet as unknown as JsonValue,
        ...(executionFacet === undefined
          ? {}
          : { execution: executionFacet as unknown as JsonValue }),
      },
      source: { inputs: [], inputCompleteness: 'partial', captureSelection },
    };

    ensureWritten(await writeContextSnapshot(workspaceRoot, snapshot));
    throw error;
  }
  const facet = normalizeTestFacet(workspaceRoot, result, relation);
  const executionFacet =
    execution === undefined
      ? undefined
      : !captureExecution
        ? unavailableExecutionFacet(execution)
        : await normalizeExecutionFacet(
            workspaceRoot,
            target.packageRoot,
            execution,
            result.coverage,
            sourceDigests,
          );
  const recording = await collectContextInputFiles(workspaceRoot, [
    ...new Set([
      ...facet.files.map((file) => file.path),
      ...(facet.relation?.sources ?? []),
      ...(facet.relation?.testFiles ?? []),
    ]),
  ]);
  const executionInputs =
    executionFacet?.files.flatMap((file) =>
      file.digest === undefined ? [] : [{ path: file.path, digest: file.digest }],
    ) ?? [];
  const inputs = [
    ...new Map(
      [...recording.inputs, ...executionInputs].map((input) => [input.path, input]),
    ).values(),
  ].sort((left, right) => left.path.localeCompare(right.path));
  const unreadableInputs = recording.unreadablePaths.filter(
    (unreadablePath) => !inputs.some((input) => input.path === unreadablePath),
  );
  const inputError =
    unreadableInputs.length === 0
      ? undefined
      : Object.assign(
          new Error(
            `Could not read Rstest snapshot inputs: ${unreadableInputs.join(', ')}. Ensure the selected sources and reported test files exist and are readable.`,
          ),
          { name: 'TestInputError' },
        );
  const persistedFacet: TestFacet =
    inputError === undefined
      ? facet
      : {
          ...facet,
          unhandledErrors: [
            ...facet.unhandledErrors,
            {
              name: inputError.name,
              message: inputError.message,
              ...optionalString('stack', inputError.stack),
            },
          ],
        };
  const snapshot: ContextSnapshot = {
    schemaVersion: contextStoreSchemaVersion,
    snapshotId: dependencies.createSnapshotId?.() ?? `snap_${Date.now()}_${randomUUID()}`,
    runId: run.runId,
    contextId: context.contextId,
    sequence: 0,
    observedAt: now().toISOString(),
    status: inputError === undefined ? getRunStatus(result) : 'error',
    completeness: {
      test: inputError === undefined ? 'complete' : 'partial',
      ...(executionFacet === undefined
        ? {}
        : {
            execution:
              executionFacet.availability === 'available' &&
              executionFacet.universe.completeness === 'complete'
                ? 'complete'
                : 'partial',
          }),
      ...(unreadableInputs.length === 0 ? {} : { source: 'partial' as const }),
    },
    facets: {
      test: persistedFacet as unknown as JsonValue,
      ...(executionFacet === undefined
        ? {}
        : { execution: executionFacet as unknown as JsonValue }),
    },
    source: {
      inputs,
      inputCompleteness: 'partial',
      captureSelection,
      ...(unreadableInputs.length === 0 ? {} : { unreadableInputs }),
    },
  };

  ensureWritten(await writeContextSnapshot(workspaceRoot, snapshot));
  if (inputError !== undefined) throw inputError;
  const errors: TestCaptureError[] = [
    ...facet.files.flatMap((file) =>
      (file.errors ?? []).map((error) => ({
        ...error,
        scope: 'file' as const,
        project: file.project,
        path: file.path,
      })),
    ),
    ...facet.unhandledErrors.map((error) => ({ ...error, scope: 'run' as const })),
  ];
  return {
    runId: run.runId,
    contextId: context.contextId,
    snapshotId: snapshot.snapshotId,
    status: snapshot.status,
    freshness: await assessSnapshotFreshness(workspaceRoot, snapshot),
    summary: {
      files: facet.stats.files.total,
      failedFiles: facet.stats.files.failed,
      tests: facet.stats.tests.total,
      failedTests: facet.stats.tests.failed,
      errors: errors.length,
      unhandledErrors: facet.unhandledErrors.length,
    },
    ...(executionFacet === undefined
      ? {}
      : {
          execution: {
            provider: executionFacet.provider,
            availability: executionFacet.availability,
            completeness: executionFacet.universe.completeness,
          },
        }),
    ...(errors.length === 0 ? {} : { errors }),
    ...(facet.unhandledErrors.length === 0 ? {} : { unhandledErrors: facet.unhandledErrors }),
    ...(unreadableInputs.length === 0 ? {} : { unreadableInputs }),
  };
};

const listTestResults = async (
  workspaceRoot: string,
  query: TestResultsQuery,
): Promise<TestResultPage> => {
  const stored =
    query.snapshotId === undefined
      ? (await readContextSnapshots(workspaceRoot, { producer: 'rstest' })).find(
          ({ snapshot }) =>
            snapshot.completeness.test === 'complete' && snapshot.facets.test !== undefined,
        )
      : await readContextSnapshotById(workspaceRoot, query.snapshotId);
  if (stored === undefined || stored.run.producer !== 'rstest') {
    throw new Error('Rstest snapshot not found.');
  }
  const facet = stored.snapshot.facets.test as unknown as TestFacet | undefined;
  if (facet?.producer !== 'rstest') throw new Error('Rstest snapshot has no test facet.');

  const items = facet.files
    .flatMap((file) => file.tests)
    .filter(
      (item) =>
        (query.project === undefined || item.project === query.project) &&
        (query.pathPrefix === undefined || item.path.startsWith(query.pathPrefix)) &&
        (query.status === undefined || item.status === query.status),
    )
    .sort(compareTestCases);
  const cursorScope = {
    surface: 'test_results',
    selectedSnapshotId: stored.snapshot.snapshotId,
    snapshotId: query.snapshotId,
    project: query.project,
    pathPrefix: query.pathPrefix,
    status: query.status,
  };
  const offset = decodeCursor(query.cursor, 'Invalid test result cursor.', cursorScope);
  const limit = query.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('Test result limit must be an integer from 1 to 200.');
  }
  const pageItems = items.slice(offset, offset + limit);
  const nextOffset = offset + pageItems.length;
  return {
    producer: 'rstest',
    contextId: stored.snapshot.contextId,
    snapshotId: stored.snapshot.snapshotId,
    observedAt: stored.snapshot.observedAt,
    completeness: stored.snapshot.completeness,
    freshness: await assessSnapshotFreshness(workspaceRoot, stored.snapshot),
    total: items.length,
    items: pageItems,
    ...(nextOffset < items.length ? { nextCursor: encodeCursor(nextOffset, cursorScope) } : {}),
  };
};

export { captureTestSnapshot, listRelatedTests, listTestResults };
export type {
  CapturedTestRunResult,
  CreateRstestRuntime,
  RelatedTestSelection,
  TestCaptureDependencies,
  TestCaptureError,
  TestCaptureResult,
  TestResultPage,
  TestResultsQuery,
  TestSnapshotRequest,
};
