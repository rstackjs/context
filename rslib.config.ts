import { defineConfig } from '@rslib/core';
import pkgJson from './package.json' with { type: 'json' };

export default defineConfig({
  dts: true,
  syntax: 'es2023',
  source: {
    entry: {
      index: './src/index.ts',
      mcp: './src/mcp.ts',
      rsbuild: './src/rsbuild.ts',
      rsdoctor: './src/rsdoctor.ts',
      rslib: './src/rslib.ts',
      rslint: './src/rslint.ts',
      rstack: './src/rstack.ts',
      rstest: './src/rstest.ts',
    },
    define: {
      RSTACK_CONTEXT_VERSION: JSON.stringify(pkgJson.version),
    },
  },
  output: {
    minify: false,
  },
});
