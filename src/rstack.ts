import type { ConfigParams, RsbuildConfig } from '@rsbuild/core';
import { appendBuildContextPlugin, createBuildContextPlugin } from './build.ts';
import { resolveContextCapture, type ContextConfig } from './config.ts';
import { recordContextInputFiles } from './source.ts';
import { resolveContextWorkspace } from './workspace.ts';

type ContextRstackPluginOptions = {
  config?: ContextConfig;
  configFilePath: string | null;
  configDependencies: readonly string[];
  cwd: string;
};

type ContextRstackModifierContext = Readonly<{ params: ConfigParams }>;

type ContextBuildConfig = {
  plugins?: RsbuildConfig['plugins'];
};

type ContextBuildModifier = <Config extends ContextBuildConfig>(
  config: Config,
  context: ContextRstackModifierContext,
) => Config | Promise<Config>;

type ContextRstackPluginApi = {
  modifyConfig(kind: 'app' | 'lib', handler: ContextBuildModifier): void;
};

type ContextRstackPlugin = {
  name: 'rstack:context';
  setup(api: ContextRstackPluginApi): void;
};

const createRstackContextPlugin = (options: ContextRstackPluginOptions): ContextRstackPlugin => ({
  name: 'rstack:context',
  setup(api) {
    const capture = resolveContextCapture(options.config);
    if (capture === 'off') return;

    const configPath = options.configFilePath ?? undefined;
    let commonOptionsPromise:
      | Promise<{
          inputs?: Awaited<ReturnType<typeof recordContextInputFiles>>;
          workspace: Awaited<ReturnType<typeof resolveContextWorkspace>>;
        }>
      | undefined;
    const resolveCommonOptions = () =>
      (commonOptionsPromise ??= (async () => {
        const workspace = await resolveContextWorkspace(configPath ?? options.cwd);
        const inputs =
          configPath === undefined
            ? undefined
            : await recordContextInputFiles(workspace.workspaceRoot, [
                ...new Set([configPath, ...options.configDependencies]),
              ]);
        return { workspace, inputs };
      })());

    const register = (
      kind: 'app' | 'lib',
      producer: 'rsbuild' | 'rslib',
      product: 'application' | 'library',
    ): void => {
      api.modifyConfig(kind, async (config, { params }) => {
        const common = await resolveCommonOptions();
        return appendBuildContextPlugin(
          config,
          createBuildContextPlugin({
            producer,
            product,
            capture,
            ...common,
            configPath,
            params,
            variant: options.config?.variant,
          }),
        );
      });
    };

    register('app', 'rsbuild', 'application');
    register('lib', 'rslib', 'library');
  },
});

export { createRstackContextPlugin };
export type {
  ContextBuildModifier,
  ContextRstackModifierContext,
  ContextRstackPlugin,
  ContextRstackPluginApi,
  ContextRstackPluginOptions,
};
