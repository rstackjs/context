import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getNonEmptyString, isRecordObject } from './guards.ts';
import type { JsonValue } from './model.ts';

const supportedToolNames = [
  'build_summary',
  'bundle_optimize',
  'chunks_list',
  'errors_list',
  'packages_direct_dependencies',
  'packages_duplicates',
  'packages_similar',
  'tree_shaking_retained_modules',
  'tree_shaking_side_effects',
  'tree_shaking_summary',
] as const;

const artifactSectionNames = [
  'errors',
  'configs',
  'summary',
  'resolver',
  'loader',
  'moduleGraph',
  'chunkGraph',
  'moduleCodeMap',
  'plugin',
  'packageGraph',
  'treeShaking',
  'otherReports',
] as const;

const artifactOmissionReasons = [
  'not-selected',
  'output-mode',
  'feature-disabled',
  'not-collected',
] as const;

type RsdoctorToolName = (typeof supportedToolNames)[number];
type RsdoctorArtifactSectionName = (typeof artifactSectionNames)[number];
type RsdoctorArtifactOmissionReason = (typeof artifactOmissionReasons)[number];

type RsdoctorSectionEvidence =
  | { section: RsdoctorArtifactSectionName; status: 'collected' }
  | {
      section: RsdoctorArtifactSectionName;
      status: 'omitted';
      reason: RsdoctorArtifactOmissionReason;
    };

type RsdoctorToolDescriptor = {
  name: RsdoctorToolName;
  description: string;
  inputSchema: Record<string, JsonValue>;
};

type RsdoctorAnalysisRequest = {
  dataFile: string;
  toolName: string;
  input?: Record<string, unknown>;
};

type RsdoctorAnalysisResult = {
  toolName: string;
  dataFile: string;
  result: JsonValue;
  sectionEvidence: RsdoctorSectionEvidence[];
  artifactMetadata?: RsdoctorArtifactMetadata;
};

type RsdoctorArtifactCompilationIdentity = {
  compilationHash?: string;
  target?: string | string[];
  environment?: string;
};

type RsdoctorArtifactCompilerIdentity = RsdoctorArtifactCompilationIdentity & {
  name: string;
  stage?: number;
};

type RsdoctorArtifactMetadata = {
  schemaVersion: 1;
  producer: { name: string; version: string };
  output: { mode: 'brief' | 'normal' };
  build: RsdoctorArtifactCompilationIdentity & {
    id: string;
    root: string;
    compiler: { name: string; type?: string; version?: string };
    compilers?: RsdoctorArtifactCompilerIdentity[];
  };
  sections: Record<
    string,
    { status: 'collected' } | { status: 'omitted'; reason: RsdoctorArtifactOmissionReason }
  >;
};

type RsdoctorArtifact = {
  path: string;
  data: Record<string, unknown>;
  metadata?: RsdoctorArtifactMetadata;
};

type RsdoctorAdapter = {
  catalog: RsdoctorToolDescriptor[];
  executor: ReturnType<
    (typeof import('@rsdoctor/agent-cli'))['createInProcessRsdoctorCliToolExecutor']
  >;
};

const isSupportedToolName = (name: string): name is RsdoctorToolName =>
  supportedToolNames.some((supportedName) => supportedName === name);

const isArtifactOmissionReason = (reason: unknown): reason is RsdoctorArtifactOmissionReason =>
  artifactOmissionReasons.some((supportedReason) => supportedReason === reason);

const requiredSectionsByTool = {
  build_summary: ['summary'],
  bundle_optimize: ['chunkGraph', 'errors', 'packageGraph'],
  chunks_list: ['chunkGraph'],
  errors_list: ['errors'],
  packages_direct_dependencies: ['packageGraph'],
  packages_duplicates: ['errors'],
  packages_similar: ['packageGraph'],
  tree_shaking_retained_modules: ['chunkGraph', 'moduleGraph', 'packageGraph'],
  tree_shaking_side_effects: ['moduleGraph'],
  tree_shaking_summary: ['errors'],
} as const satisfies Record<RsdoctorToolName, readonly RsdoctorArtifactSectionName[]>;

let adapterPromise: Promise<RsdoctorAdapter> | undefined;

const loadAdapter = async (): Promise<RsdoctorAdapter> => {
  const { createInProcessRsdoctorCliToolExecutor, getToolCatalog } =
    await import('@rsdoctor/agent-cli');
  const packageCatalog = getToolCatalog();
  const catalog = supportedToolNames.map((name) => {
    const tool = packageCatalog.find((entry) => entry.name === name);
    if (tool === undefined) {
      throw new Error(`Rsdoctor catalog is missing ${name}.`);
    }

    return {
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, JsonValue>,
      name,
    };
  });

  return {
    catalog,
    executor: createInProcessRsdoctorCliToolExecutor(),
  };
};

const getAdapter = (): Promise<RsdoctorAdapter> => (adapterPromise ??= loadAdapter());

const listRsdoctorToolNames = (): RsdoctorToolName[] => [...supportedToolNames];

const matchesSchemaType = (value: unknown, type: unknown): boolean => {
  if (Array.isArray(type)) {
    return type.some((entry) => matchesSchemaType(value, entry));
  }

  switch (type) {
    case 'array':
      return Array.isArray(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'null':
      return value === null;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'object':
      return isRecordObject(value);
    case 'string':
      return typeof value === 'string';
    default:
      return true;
  }
};

const matchesJsonSchema = (value: unknown, schema: unknown): boolean => {
  if (!isRecordObject(schema) || !matchesSchemaType(value, schema.type)) {
    return false;
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      return false;
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      return false;
    }
  }

  if (Array.isArray(value) && isRecordObject(schema.items)) {
    return value.every((entry) => matchesJsonSchema(entry, schema.items));
  }

  if (!isRecordObject(value)) {
    return true;
  }

  const properties = isRecordObject(schema.properties) ? schema.properties : {};
  if (
    Array.isArray(schema.required) &&
    schema.required.some((key) => typeof key === 'string' && !(key in value))
  ) {
    return false;
  }

  for (const [key, entry] of Object.entries(value)) {
    const propertySchema = properties[key];
    if (propertySchema !== undefined) {
      if (!matchesJsonSchema(entry, propertySchema)) {
        return false;
      }
    } else if (schema.additionalProperties === false) {
      return false;
    } else if (isRecordObject(schema.additionalProperties)) {
      if (!matchesJsonSchema(entry, schema.additionalProperties)) {
        return false;
      }
    }
  }

  return true;
};

const getInput = (input: unknown, tool: RsdoctorToolDescriptor): Record<string, unknown> => {
  const resolvedInput = input === undefined ? {} : input;
  if (!isRecordObject(resolvedInput) || !matchesJsonSchema(resolvedInput, tool.inputSchema)) {
    throw new Error('Rsdoctor tool input does not match its schema.');
  }

  return resolvedInput;
};

const getCompilationIdentity = (
  value: Record<string, unknown>,
): RsdoctorArtifactCompilationIdentity | undefined => {
  const compilationHash = getNonEmptyString(value.compilationHash);
  const environment = getNonEmptyString(value.environment);
  const target = getNonEmptyString(value.target);
  const targets = Array.isArray(value.target)
    ? value.target.filter((entry): entry is string => getNonEmptyString(entry) !== undefined)
    : undefined;
  if (Array.isArray(value.target) && targets?.length !== value.target.length) return undefined;
  if (value.target !== undefined && target === undefined && targets === undefined) return undefined;
  if (value.compilationHash !== undefined && compilationHash === undefined) return undefined;
  if (value.environment !== undefined && environment === undefined) return undefined;
  return {
    ...(compilationHash === undefined ? {} : { compilationHash }),
    ...(target === undefined ? (targets === undefined ? {} : { target: targets }) : { target }),
    ...(environment === undefined ? {} : { environment }),
  };
};

const getArtifactMetadata = (value: unknown): RsdoctorArtifactMetadata | undefined => {
  if (!isRecordObject(value) || value.schemaVersion !== 1) return undefined;
  if (
    !isRecordObject(value.producer) ||
    !isRecordObject(value.output) ||
    !isRecordObject(value.build)
  ) {
    return undefined;
  }
  if (!isRecordObject(value.build.compiler) || !isRecordObject(value.sections)) return undefined;

  const producerName = getNonEmptyString(value.producer.name);
  const producerVersion = getNonEmptyString(value.producer.version);
  const mode = value.output.mode;
  const id = getNonEmptyString(value.build.id);
  const root = getNonEmptyString(value.build.root);
  const compilerName = getNonEmptyString(value.build.compiler.name);
  const compilerType = getNonEmptyString(value.build.compiler.type);
  const compilerVersion = getNonEmptyString(value.build.compiler.version);
  const identity = getCompilationIdentity(value.build);
  if (
    producerName !== '@rsdoctor/core' ||
    producerVersion === undefined ||
    (mode !== 'brief' && mode !== 'normal') ||
    id === undefined ||
    root === undefined ||
    compilerName === undefined ||
    identity === undefined
  ) {
    return undefined;
  }
  if (
    (value.build.compiler.type !== undefined && compilerType === undefined) ||
    (value.build.compiler.version !== undefined && compilerVersion === undefined)
  ) {
    return undefined;
  }

  const sections: RsdoctorArtifactMetadata['sections'] = {};
  for (const [name, state] of Object.entries(value.sections)) {
    if (!isRecordObject(state)) return undefined;
    if (state.status === 'collected') {
      sections[name] = { status: 'collected' };
    } else if (state.status === 'omitted' && isArtifactOmissionReason(state.reason)) {
      sections[name] = { status: 'omitted', reason: state.reason };
    } else {
      return undefined;
    }
  }
  if (artifactSectionNames.some((name) => sections[name] === undefined)) return undefined;

  let compilers: RsdoctorArtifactCompilerIdentity[] | undefined;
  if (value.build.compilers !== undefined) {
    if (!Array.isArray(value.build.compilers)) return undefined;
    compilers = [];
    for (const entry of value.build.compilers) {
      if (!isRecordObject(entry)) return undefined;
      const name = getNonEmptyString(entry.name);
      const compilerIdentity = getCompilationIdentity(entry);
      if (
        name === undefined ||
        compilerIdentity === undefined ||
        (entry.stage !== undefined &&
          (typeof entry.stage !== 'number' || !Number.isFinite(entry.stage)))
      ) {
        return undefined;
      }
      compilers.push({
        name,
        ...(entry.stage === undefined ? {} : { stage: entry.stage }),
        ...compilerIdentity,
      });
    }
  }

  return {
    schemaVersion: 1,
    producer: { name: producerName, version: producerVersion },
    output: { mode },
    build: {
      id,
      root,
      compiler: {
        name: compilerName,
        ...(compilerType === undefined ? {} : { type: compilerType }),
        ...(compilerVersion === undefined ? {} : { version: compilerVersion }),
      },
      ...identity,
      ...(compilers === undefined ? {} : { compilers }),
    },
    sections,
  };
};

const readRsdoctorArtifact = async (
  workspaceRoot: string,
  dataFile: string,
): Promise<RsdoctorArtifact> => {
  const artifactPath = path.resolve(workspaceRoot, dataFile);
  let contents: string;
  try {
    contents = await readFile(artifactPath, 'utf8');
  } catch (error) {
    const cause = error instanceof Error ? ` Cause: ${error.message}` : '';
    throw new Error(
      `Rsdoctor data file could not be read at "${artifactPath}". Generate a brief JSON artifact by setting RSDOCTOR_OUTPUT=json for the build.${cause}`,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error('Rsdoctor data file must contain valid JSON.');
  }

  if (!isRecordObject(parsed) || !isRecordObject(parsed.data)) {
    throw new Error('Rsdoctor data file must contain an object data field.');
  }

  const metadata = getArtifactMetadata(parsed.metadata);
  return {
    path: artifactPath,
    data: parsed.data,
    ...(metadata === undefined ? {} : { metadata }),
  };
};

const toRelativeWorkspaceFile = (workspaceRoot: string, file: string): string =>
  path.relative(workspaceRoot, file).split(path.sep).join('/');

const resolveRsdoctorDataFile = async (
  workspaceRoot: string,
  dataFile: string,
): Promise<string> => {
  const artifact = await readRsdoctorArtifact(workspaceRoot, dataFile);
  return toRelativeWorkspaceFile(workspaceRoot, artifact.path);
};

const analyzeRsdoctorArtifact = async (
  workspaceRoot: string,
  request: RsdoctorAnalysisRequest,
): Promise<RsdoctorAnalysisResult> => {
  if (!isRecordObject(request) || typeof request.toolName !== 'string' || !request.toolName) {
    throw new Error('Rsdoctor tool name is invalid.');
  }
  if (!isSupportedToolName(request.toolName)) {
    throw new Error('Unknown Rsdoctor tool.');
  }

  const { catalog, executor } = await getAdapter();
  const tool = catalog.find(({ name }) => name === request.toolName)!;
  const input = getInput(request.input, tool);
  const artifact = await readRsdoctorArtifact(workspaceRoot, request.dataFile);

  let result: unknown;
  try {
    result = await executor.execute({
      dataFile: artifact.path,
      input,
      toolName: request.toolName,
    });
  } catch {
    throw new Error('Rsdoctor analysis failed.');
  }

  const metadata = artifact.metadata;
  return {
    dataFile: request.dataFile,
    ...(metadata === undefined ? {} : { artifactMetadata: metadata }),
    result: result as JsonValue,
    sectionEvidence:
      metadata === undefined
        ? []
        : requiredSectionsByTool[request.toolName].map((section) => ({
            section,
            ...metadata.sections[section],
          })),
    toolName: request.toolName,
  };
};

export {
  analyzeRsdoctorArtifact,
  listRsdoctorToolNames,
  readRsdoctorArtifact,
  resolveRsdoctorDataFile,
};
export type {
  RsdoctorAnalysisRequest,
  RsdoctorAnalysisResult,
  RsdoctorArtifact,
  RsdoctorArtifactCompilationIdentity,
  RsdoctorArtifactMetadata,
  RsdoctorArtifactOmissionReason,
  RsdoctorArtifactSectionName,
  RsdoctorSectionEvidence,
};
