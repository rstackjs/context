import { defineConfig, globalIgnores, ts } from '@rslint/core';

export default defineConfig([
  globalIgnores(['coverage/**', 'dist/**', 'dist-tests/**']),
  ts.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './tests/tsconfig.json'],
      },
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: String.raw`^\.{1,2}/.*\.js$`,
              message: 'Use the .ts extension for relative imports.',
            },
          ],
        },
      ],
    },
  },
]);
