import { realpath } from 'node:fs/promises';
import { sha256Hex } from './guards.ts';
import {
  type ContextRunManifest,
  type ContextSnapshot,
  type ProjectContextStatus,
  type ProjectStatus,
} from './model.ts';
import { compareStrings } from './order.ts';
import { assessSnapshotFreshness } from './source.ts';
import { readContextWorkspaceStatus } from './store.ts';

const compareProjectContexts = (
  left: ProjectContextStatus & { startedAt: string },
  right: ProjectContextStatus & { startedAt: string },
): number => {
  const fields = [
    [left.context.packageRoot, right.context.packageRoot],
    [left.context.product, right.context.product],
    [left.context.environment ?? '', right.context.environment ?? ''],
    [left.startedAt, right.startedAt],
    [left.runId, right.runId],
  ] as const;

  for (const [leftValue, rightValue] of fields) {
    const result = compareStrings(leftValue, rightValue);
    if (result !== 0) return result;
  }
  return 0;
};

type SnapshotObservation = { run: ContextRunManifest; snapshot: ContextSnapshot };

const isNewerRun = (current: ContextRunManifest, candidate: ContextRunManifest): boolean =>
  compareStrings(current.startedAt, candidate.startedAt) < 0 ||
  (current.startedAt === candidate.startedAt && compareStrings(current.runId, candidate.runId) < 0);

// A run without a snapshot (an aborted build, a capture that only wrote its manifest) must not hide
// the newest completed snapshot recorded for the same context by an earlier run.
const newerObservation = (
  current: SnapshotObservation | undefined,
  candidate: SnapshotObservation,
): SnapshotObservation =>
  current === undefined ||
  compareStrings(current.snapshot.observedAt, candidate.snapshot.observedAt) < 0 ||
  (current.snapshot.observedAt === candidate.snapshot.observedAt &&
    isNewerRun(current.run, candidate.run))
    ? candidate
    : current;

const isCompleteSuccessfulObservation = ({ snapshot }: SnapshotObservation): boolean =>
  snapshot.status === 'pass' && Object.values(snapshot.completeness).includes('complete');

const readProjectStatus = async (workspaceRoot: string): Promise<ProjectStatus> => {
  const workspace = await readContextWorkspaceStatus(workspaceRoot);
  const workspacePath = await realpath(workspaceRoot);
  const workspaceId = `ws_${sha256Hex(workspacePath).slice(0, 24)}`;
  const currentByContextId = new Map<
    string,
    (typeof workspace.runs)[number]['contexts'][number] & {
      run: (typeof workspace.runs)[number]['run'];
      observation?: SnapshotObservation;
      latestAttempt?: SnapshotObservation;
    }
  >();

  for (const { run, contexts } of workspace.runs) {
    for (const contextStatus of contexts) {
      const current = currentByContextId.get(contextStatus.context.contextId);
      const candidate =
        contextStatus.latestSnapshot === undefined
          ? undefined
          : { run, snapshot: contextStatus.latestSnapshot };
      const observation =
        candidate === undefined || !isCompleteSuccessfulObservation(candidate)
          ? current?.observation
          : newerObservation(current?.observation, candidate);
      const latestAttempt =
        candidate === undefined
          ? current?.latestAttempt
          : newerObservation(current?.latestAttempt, candidate);
      const newest =
        current === undefined || isNewerRun(current.run, run)
          ? { context: contextStatus.context, run }
          : { context: current.context, run: current.run };
      currentByContextId.set(contextStatus.context.contextId, {
        ...newest,
        ...(observation === undefined ? {} : { observation }),
        ...(latestAttempt === undefined ? {} : { latestAttempt }),
      });
    }
  }

  const contexts = (
    await Promise.all(
      [...currentByContextId.values()].map(
        async ({ run, context, observation, latestAttempt }) => ({
          runId: run.runId,
          producer: run.producer,
          context,
          state:
            observation === undefined && latestAttempt === undefined
              ? ('pending' as const)
              : ('ready' as const),
          ...(observation === undefined
            ? {}
            : {
                latestSnapshot: observation.snapshot,
                freshness: await assessSnapshotFreshness(workspaceRoot, observation.snapshot),
              }),
          ...(latestAttempt === undefined ||
          latestAttempt.snapshot.snapshotId === observation?.snapshot.snapshotId
            ? {}
            : { latestAttempt: latestAttempt.snapshot }),
          startedAt: run.startedAt,
        }),
      ),
    )
  )
    .sort(compareProjectContexts)
    .map(({ startedAt: _, ...context }) => context satisfies ProjectContextStatus);

  return {
    schemaVersion: workspace.schemaVersion,
    workspaceId,
    contexts,
    issues: workspace.issues,
  };
};

export { readProjectStatus };
