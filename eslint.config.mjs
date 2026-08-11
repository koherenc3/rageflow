import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

export default tseslint.config(
  {
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...compat.extends('next/core-web-vitals'),
  {
    rules: {
      // Type-only imports are enforced by `verbatimModuleSyntax` in
      // tsconfig.json, which is a compiler error rather than a lint warning.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // The prediction engine must stay pure TypeScript: no React, no Next, no
    // browser globals. See docs/DECISIONS.md.
    files: ['src/engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react-*', 'next', 'next/*', '@/app/*'],
              message:
                'src/engine must not import React, Next, or app code. Keep the engine portable.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'src/engine must not touch browser globals.' },
        { name: 'document', message: 'src/engine must not touch browser globals.' },
        { name: 'localStorage', message: 'src/engine must not touch browser globals.' },
        { name: 'navigator', message: 'src/engine must not touch browser globals.' },
        { name: 'fetch', message: 'src/engine must not touch the network.' },
      ],
    },
  },
  prettier
);
