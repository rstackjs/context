import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { LintMessage, LintResult, RslintOptions } from '@rslint/core';
import { sha256Hex } from './guards.ts';
import {
  contextStoreSchemaVersion,
  type ContextFreshness,
  type ContextRunStatus,
  type ContextSnapshot,
  type LintFacet,
  type LintFileRecord,
  type LintMessageRecord,
  type StoredContextSnapshot,
  type TestErrorRecord,
  type TestFacet,
} from './model.ts';
import { compareStrings } from './order.ts';
import { decodeCursor, encodeCursor } from './pagination.ts';
import { toWorkspacePath } from './paths.ts';
import {
  assessSnapshotFreshness,
  createExplicitContextDescriptor,
  createExplicitRun,
  recordContextInputFiles,
  resolveExplicitCaptureTarget,
} from './source.ts';
import {
  readContextSnapshotById,
  readContextSnapshots,
  writeContextRunManifest,
  writeContextSnapshot,
} from './store.ts';

type LintSnapshotRequest =
  | {
      mode: 'files';
      patterns?: string[];
      includeFixPreview?: boolean;
      packageRoot?: string;
      configPath?: string;
    }
  | {
      mode: 'text';
      code: string;
      filePath: string;
      includeFixPreview?: boolean;
      packageRoot?: string;
      configPath?: string;
    };

type LintCaptureResult = {
  runId: string;
  contextId: string;
  snapshotId: string;
  status: ContextRunStatus;
  freshness: ContextFreshness;
  summary: LintFacet['totals'];
  unreadableInputs?: string[];
};

type RslintEngine = {
  lintFiles: (patterns: string | string[]) => Promise<LintResult[]>;
  lintText: (code: string, options?: { filePath?: string }) => Promise<LintResult[]>;
  close: () => Promise<void>;
};

type RslintFactory = (options: RslintOptions) => RslintEngine;

type DiagnosticsQuery = {
  snapshotId?: string;
  producer?: 'rslint' | 'rstest';
  pathPrefix?: string;
  severity?: 'error' | 'warning';
  ruleId?: string;
  limit?: number;
  cursor?: string;
};

type LintFacetDiagnostic = {
  path: string;
  ruleId: string | null;
  severity: 'error' | 'warning';
  message: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  fixable: boolean;
};

type DiagnosticRecord = {
  producer: 'rslint' | 'rstest';
  path?: string;
  project?: string;
  ruleId: string | null;
  severity: 'error' | 'warning';
  message: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  fixable: boolean;
  name?: string;
};

type DiagnosticPage = {
  snapshotId: string;
  producer: 'rslint' | 'rstest';
  contextId: string;
  observedAt: string;
  completeness: ContextSnapshot['completeness'];
  freshness: ContextFreshness;
  total: number;
  items: DiagnosticRecord[];
  nextCursor?: string;
};

type LintFixPreviewResult =
  | {
      available: true;
      snapshotId: string;
      path: string;
      beforeDigest: string;
      fixedOutput: string;
    }
  | {
      available: false;
      reason: 'not-captured' | 'no-change';
      snapshotId: string;
      path: string;
    };

const defaultLimit = 50;
const maximumLimit = 200;

const normalizeMessage = (message: LintMessage): LintMessageRecord => ({
  ruleId: message.ruleId,
  severity: message.severity,
  message: message.message,
  ...(message.messageId === undefined ? {} : { messageId: message.messageId }),
  line: message.line,
  column: message.column,
  ...(message.endLine === undefined ? {} : { endLine: message.endLine }),
  ...(message.endColumn === undefined ? {} : { endColumn: message.endColumn }),
  ...(message.fix === undefined ? {} : { fix: message.fix }),
  ...(message.suggestions === undefined ? {} : { suggestions: message.suggestions }),
});

const compareMessages = (left: LintMessageRecord, right: LintMessageRecord): number =>
  left.line - right.line ||
  left.column - right.column ||
  compareStrings(left.ruleId ?? '', right.ruleId ?? '') ||
  compareStrings(left.message, right.message);

const readLintSource = async (filePath: string): Promise<string | undefined> => {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
};

const normalizeResult = async (
  workspaceRoot: string,
  result: LintResult,
  includeFixPreview: boolean,
  textCode?: string,
): Promise<LintFileRecord | undefined> => {
  const filePath = toWorkspacePath(workspaceRoot, result.filePath);
  const source = textCode ?? (await readLintSource(result.filePath));
  if (source === undefined) return undefined;
  const fileDigest = sha256Hex(source);
  const fixedOutput =
    includeFixPreview && result.output !== undefined && result.output !== source
      ? result.output
      : undefined;

  return {
    path: filePath,
    digest: fileDigest,
    errorCount: result.errorCount,
    warningCount: result.warningCount,
    fixableErrorCount: result.fixableErrorCount,
    fixableWarningCount: result.fixableWarningCount,
    messages: result.messages.map(normalizeMessage).sort(compareMessages),
    ...(fixedOutput === undefined ? {} : { fixedOutput }),
  };
};

const totalsFor = (files: LintFileRecord[]): LintFacet['totals'] => ({
  files: files.length,
  errors: files.reduce((total, file) => total + file.errorCount, 0),
  warnings: files.reduce((total, file) => total + file.warningCount, 0),
  fixableErrors: files.reduce((total, file) => total + file.fixableErrorCount, 0),
  fixableWarnings: files.reduce((total, file) => total + file.fixableWarningCount, 0),
});

const lintCaptureSelection = (
  workspaceRoot: string,
  packageRoot: string,
  request: LintSnapshotRequest,
): NonNullable<ContextSnapshot['source']>['captureSelection'] =>
  request.mode === 'files'
    ? {
        mode: 'files',
        patterns: [...new Set(request.patterns ?? ['.'])].sort(compareStrings),
      }
    : {
        mode: 'text',
        filePath: toWorkspacePath(workspaceRoot, path.resolve(packageRoot, request.filePath)),
      };

const recordLintConfigInputs = (
  workspaceRoot: string,
  packageRoot: string,
  request: LintSnapshotRequest,
) => {
  if (request.configPath !== undefined) {
    return recordContextInputFiles(workspaceRoot, [request.configPath]);
  }
  const directories = new Set<string>();
  const targets = request.mode === 'text' ? [request.filePath] : (request.patterns ?? []);
  for (let directory of [
    packageRoot,
    ...targets.map((target) => path.resolve(packageRoot, target)),
  ]) {
    while (directory === workspaceRoot || directory.startsWith(`${workspaceRoot}${path.sep}`)) {
      directories.add(directory);
      if (directory === workspaceRoot) break;
      directory = path.dirname(directory);
    }
  }
  return recordContextInputFiles(
    workspaceRoot,
    [...directories].flatMap((directory) =>
      ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].map((extension) =>
        path.join(directory, `rslint.config.${extension}`),
      ),
    ),
  );
};

const ensureWritten = (result: Awaited<ReturnType<typeof writeContextSnapshot>>): void => {
  if (!result.written)
    throw new Error('Could not write the context snapshot.', {
      cause: result.error,
    });
};

const captureLintSnapshot = async (
  workspaceRoot: string,
  request: LintSnapshotRequest,
  createRslint?: RslintFactory,
): Promise<LintCaptureResult> => {
  const includeFixPreview = request.includeFixPreview ?? false;
  const target = await resolveExplicitCaptureTarget(workspaceRoot, request);
  const configInputs = await recordLintConfigInputs(workspaceRoot, target.packageRoot, request);
  const context = createExplicitContextDescriptor({
    producer: 'rslint',
    workspaceRoot,
    ...target,
  });
  const captureSelection = lintCaptureSelection(workspaceRoot, target.packageRoot, request);
  const run = createExplicitRun({
    producer: 'rslint',
    context,
    command: 'lint',
  });
  const options = {
    cwd: target.packageRoot,
    ...(target.configPath === undefined ? {} : { overrideConfigFile: target.configPath }),
    fix: includeFixPreview,
  } satisfies RslintOptions;
  const runWrite = await writeContextRunManifest(workspaceRoot, run);
  if (!runWrite.written) {
    throw new Error('Could not write the context run.', {
      cause: runWrite.error,
    });
  }
  let results: LintResult[];
  try {
    const engine = createRslint?.(options) ?? new (await import('@rslint/core')).Rslint(options);
    try {
      results =
        request.mode === 'files'
          ? await engine.lintFiles(request.patterns ?? ['.'])
          : await engine.lintText(request.code, { filePath: request.filePath });
    } finally {
      await engine.close();
    }
    if (results.length === 0) {
      throw new Error(
        'Rslint reported no files. Verify that the native Rslint configuration and requested patterns select lint inputs.',
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const file: LintFileRecord = {
      path:
        request.mode === 'text'
          ? toWorkspacePath(workspaceRoot, path.resolve(target.packageRoot, request.filePath)) ||
            context.packageRoot
          : context.packageRoot,
      digest: request.mode === 'text' ? sha256Hex(request.code) : sha256Hex(''),
      errorCount: 1,
      warningCount: 0,
      fixableErrorCount: 0,
      fixableWarningCount: 0,
      messages: [
        {
          ruleId: null,
          severity: 2,
          message,
          line: 1,
          column: 1,
        },
      ],
    };
    const facet: LintFacet = {
      producer: 'rslint',
      mode: request.mode,
      fixPreviewCaptured: false,
      files: [file],
      totals: totalsFor([file]),
    };
    const snapshot: ContextSnapshot = {
      schemaVersion: contextStoreSchemaVersion,
      snapshotId: `snap_${run.runId}_${context.contextId}_0`,
      runId: run.runId,
      contextId: context.contextId,
      sequence: 0,
      observedAt: new Date().toISOString(),
      status: 'error',
      completeness: { lint: 'partial' },
      facets: { lint: facet },
      source: { inputs: [], inputCompleteness: 'partial', captureSelection },
    };
    ensureWritten(await writeContextSnapshot(workspaceRoot, snapshot));
    throw error;
  }

  const normalized = await Promise.all(
    results.map((result) =>
      normalizeResult(
        workspaceRoot,
        result,
        includeFixPreview,
        request.mode === 'text' ? request.code : undefined,
      ),
    ),
  );
  const files = normalized
    .flatMap((file) => (file === undefined ? [] : [file]))
    .sort((left, right) => compareStrings(left.path, right.path));
  const unreadableInputs = results
    .flatMap((result, index) =>
      normalized[index] === undefined ? [toWorkspacePath(workspaceRoot, result.filePath)] : [],
    )
    .sort(compareStrings);
  const totals = totalsFor(files);
  const facet: LintFacet = {
    producer: 'rslint',
    mode: request.mode,
    fixPreviewCaptured: includeFixPreview,
    files,
    totals,
  };
  const source: ContextSnapshot['source'] =
    request.mode === 'text'
      ? { virtualInputDigest: sha256Hex(request.code), captureSelection }
      : {
          inputs: [
            ...new Map(
              [
                ...files.map(({ path: filePath, digest }) => ({ path: filePath, digest })),
                ...configInputs,
              ].map((input) => [input.path, input]),
            ).values(),
          ].sort((left, right) => compareStrings(left.path, right.path)),
          // Rslint does not expose imported configs, nested discovery, or type dependencies.
          inputCompleteness: 'partial',
          captureSelection,
        };
  const status: ContextRunStatus = totals.errors > 0 ? 'fail' : 'pass';
  const snapshot: ContextSnapshot = {
    schemaVersion: contextStoreSchemaVersion,
    snapshotId: `snap_${run.runId}_${context.contextId}_0`,
    runId: run.runId,
    contextId: context.contextId,
    sequence: 0,
    observedAt: new Date().toISOString(),
    status,
    completeness: {
      lint: unreadableInputs.length === 0 ? 'complete' : 'partial',
      ...(unreadableInputs.length === 0 ? {} : { source: 'partial' as const }),
    },
    facets: { lint: facet },
    source,
  };

  ensureWritten(await writeContextSnapshot(workspaceRoot, snapshot));

  return {
    runId: run.runId,
    contextId: context.contextId,
    snapshotId: snapshot.snapshotId,
    status,
    freshness: await assessSnapshotFreshness(workspaceRoot, snapshot),
    summary: totals,
    ...(unreadableInputs.length === 0 ? {} : { unreadableInputs }),
  };
};

const asLintFacet = (stored: StoredContextSnapshot): LintFacet | undefined =>
  stored.run.producer === 'rslint'
    ? (stored.snapshot.facets.lint as LintFacet | undefined)
    : undefined;

const asTestFacet = (stored: StoredContextSnapshot): TestFacet | undefined =>
  stored.run.producer === 'rstest'
    ? (stored.snapshot.facets.test as TestFacet | undefined)
    : undefined;

const lintFacetDiagnostics = (facet: LintFacet): LintFacetDiagnostic[] =>
  facet.files.flatMap((file) =>
    file.messages.map((message) => ({
      path: file.path,
      ruleId: message.ruleId,
      severity: message.severity === 2 ? ('error' as const) : ('warning' as const),
      message: message.message,
      line: message.line,
      column: message.column,
      ...(message.endLine === undefined ? {} : { endLine: message.endLine }),
      ...(message.endColumn === undefined ? {} : { endColumn: message.endColumn }),
      fixable: message.fix !== undefined,
    })),
  );

const lintDiagnostics = (facet: LintFacet): DiagnosticRecord[] =>
  lintFacetDiagnostics(facet).map((diagnostic) => ({
    producer: 'rslint' as const,
    ...diagnostic,
  }));

const testDiagnostic = (
  error: TestErrorRecord,
  location: { path?: string; project?: string; name?: string },
): DiagnosticRecord => ({
  producer: 'rstest',
  ...location,
  ruleId: null,
  severity: 'error',
  message: error.message,
  fixable: false,
});

const testDiagnostics = (facet: TestFacet): DiagnosticRecord[] => [
  ...facet.files.flatMap((file) => [
    ...(file.errors ?? []).map((error) =>
      testDiagnostic(error, {
        path: file.path,
        project: file.project,
      }),
    ),
    ...file.tests.flatMap((testCase) =>
      (testCase.errors ?? []).map((error) =>
        testDiagnostic(error, {
          path: testCase.path,
          project: testCase.project,
          name: [...(testCase.parentNames ?? []), testCase.name].join(' > '),
        }),
      ),
    ),
  ]),
  ...facet.unhandledErrors.map((error) => testDiagnostic(error, {})),
];

const diagnosticsFromStoredSnapshot = (stored: StoredContextSnapshot): DiagnosticRecord[] => {
  const lintFacet = asLintFacet(stored);
  const testFacet = asTestFacet(stored);
  if (lintFacet !== undefined) return lintDiagnostics(lintFacet);
  if (testFacet !== undefined) return testDiagnostics(testFacet);
  return [];
};

const compareDiagnostics = (left: DiagnosticRecord, right: DiagnosticRecord): number =>
  compareStrings(left.project ?? '', right.project ?? '') ||
  compareStrings(left.path ?? '', right.path ?? '') ||
  (left.line ?? 0) - (right.line ?? 0) ||
  (left.column ?? 0) - (right.column ?? 0) ||
  compareStrings(left.ruleId ?? '', right.ruleId ?? '') ||
  compareStrings(left.name ?? '', right.name ?? '') ||
  compareStrings(left.message, right.message);

const getLimit = (limit: number | undefined): number => {
  const resolved = limit ?? defaultLimit;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximumLimit) {
    throw new Error('limit must be an integer from 1 to 200.');
  }
  return resolved;
};

const selectDiagnosticSnapshot = async (
  workspaceRoot: string,
  query: DiagnosticsQuery,
): Promise<StoredContextSnapshot> => {
  const stored =
    query.snapshotId === undefined
      ? (
          await readContextSnapshots(workspaceRoot, {
            producer: query.producer,
          })
        ).find(({ run }) => run.producer === 'rslint' || run.producer === 'rstest')
      : await readContextSnapshotById(workspaceRoot, query.snapshotId);
  if (stored === undefined) throw new Error('No matching completed context snapshot was found.');
  if (query.producer !== undefined && stored.run.producer !== query.producer) {
    throw new Error('The selected snapshot does not match the requested producer.');
  }
  return stored;
};

const listDiagnostics = async (
  workspaceRoot: string,
  query: DiagnosticsQuery = {},
): Promise<DiagnosticPage> => {
  const stored = await selectDiagnosticSnapshot(workspaceRoot, query);
  const lintFacet = asLintFacet(stored);
  const testFacet = asTestFacet(stored);
  if (lintFacet === undefined && testFacet === undefined) {
    throw new Error('The selected snapshot has no diagnostics facet.');
  }

  const items = (lintFacet === undefined ? testDiagnostics(testFacet!) : lintDiagnostics(lintFacet))
    .filter((item) => query.pathPrefix === undefined || item.path?.startsWith(query.pathPrefix))
    .filter((item) => query.severity === undefined || item.severity === query.severity)
    .filter((item) => query.ruleId === undefined || item.ruleId === query.ruleId)
    .sort(compareDiagnostics);
  const cursorScope = {
    surface: 'diagnostics_list',
    selectedSnapshotId: stored.snapshot.snapshotId,
    snapshotId: query.snapshotId,
    producer: query.producer,
    pathPrefix: query.pathPrefix,
    severity: query.severity,
    ruleId: query.ruleId,
  };
  const offset = decodeCursor(query.cursor, 'Invalid diagnostics cursor.', cursorScope);
  const limit = getLimit(query.limit);
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;

  return {
    snapshotId: stored.snapshot.snapshotId,
    producer: lintFacet === undefined ? 'rstest' : 'rslint',
    contextId: stored.snapshot.contextId,
    observedAt: stored.snapshot.observedAt,
    completeness: stored.snapshot.completeness,
    freshness: await assessSnapshotFreshness(workspaceRoot, stored.snapshot),
    total: items.length,
    items: page,
    ...(nextOffset < items.length ? { nextCursor: encodeCursor(nextOffset, cursorScope) } : {}),
  };
};

const getLintFixPreview = async (
  workspaceRoot: string,
  snapshotId: string,
  filePath: string,
): Promise<LintFixPreviewResult> => {
  const stored = await readContextSnapshotById(workspaceRoot, snapshotId);
  if (stored === undefined) throw new Error(`Unknown snapshot: ${snapshotId}`);
  const facet = asLintFacet(stored);
  if (facet === undefined) throw new Error('The selected snapshot has no lint facet.');
  const matches = facet.files.filter(({ path: candidate }) => candidate === filePath);
  if (matches.length !== 1) throw new Error('The lint snapshot does not contain that exact path.');
  const file = matches[0];
  if (!facet.fixPreviewCaptured) {
    return {
      available: false,
      reason: 'not-captured',
      snapshotId,
      path: filePath,
    };
  }
  if (file.fixedOutput === undefined) {
    return {
      available: false,
      reason: 'no-change',
      snapshotId,
      path: filePath,
    };
  }
  return {
    available: true,
    snapshotId,
    path: filePath,
    beforeDigest: file.digest,
    fixedOutput: file.fixedOutput,
  };
};

export {
  captureLintSnapshot,
  diagnosticsFromStoredSnapshot,
  getLintFixPreview,
  lintFacetDiagnostics,
  listDiagnostics,
};
export type {
  DiagnosticPage,
  DiagnosticRecord,
  DiagnosticsQuery,
  LintCaptureResult,
  LintFacetDiagnostic,
  LintFixPreviewResult,
  LintSnapshotRequest,
  RslintFactory,
};
