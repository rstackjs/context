import type { ConfigParams, RsbuildConfig } from '@rsbuild/core';
import { createBuildContextPlugin } from './build.ts';
import { resolveContextCapture, type ContextConfig } from './config.ts';

type ContextProduct = 'application' | 'library';

type RstackContextConfigOptions = ContextConfig & {
  products: ContextProduct | readonly ContextProduct[];
};

type ContextRstackConfig = {
  app?: (params: ConfigParams) => Promise<{
    plugins: NonNullable<RsbuildConfig['plugins']>;
  }>;
  lib?: (params: ConfigParams) => Promise<{
    plugins: NonNullable<RsbuildConfig['plugins']>;
  }>;
};

type ContextConfigFactoryOptions = {
  capture: 'metadata' | 'deep';
  variant?: string;
};

const createConfigFactory = (
  producer: 'rsbuild' | 'rslib',
  product: ContextProduct,
  options: ContextConfigFactoryOptions,
): NonNullable<ContextRstackConfig['app']> => {
  return async (params) => ({
    plugins: [
      createBuildContextPlugin({
        producer,
        product,
        capture: options.capture,
        params,
        variant: options.variant,
      }),
    ],
  });
};

const createRstackContextConfig = (options: RstackContextConfigOptions): ContextRstackConfig => {
  const capture = resolveContextCapture({
    enabled: options.enabled ?? true,
    capture: options.capture,
    variant: options.variant,
  });
  if (capture === 'off') return {};

  const products = new Set(
    typeof options.products === 'string' ? [options.products] : options.products,
  );
  if (
    products.size === 0 ||
    [...products].some((product) => product !== 'application' && product !== 'library')
  ) {
    throw new Error('Rstack Context products must contain "application", "library", or both.');
  }

  const factoryOptions: ContextConfigFactoryOptions = {
    capture,
    variant: options.variant,
  };

  return {
    ...(products.has('application')
      ? { app: createConfigFactory('rsbuild', 'application', factoryOptions) }
      : {}),
    ...(products.has('library')
      ? { lib: createConfigFactory('rslib', 'library', factoryOptions) }
      : {}),
  };
};

export { createRstackContextConfig };
export type { ContextProduct, ContextRstackConfig, RstackContextConfigOptions };
