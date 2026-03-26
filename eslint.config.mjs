import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const nodeGlobals = {
  ...globals.node
};

export default [
  {
    ignores: [
      'node_modules/**',
      'data/**',
      '.git/**',
      'frontend/.svelte-kit/**',
      'frontend/build/**',
      'frontend/svelte.config.js',
      'frontend/static/theme-init.js',
      'frontend/src/**',
      'playwright-report/**',
      'test-results/**',
      'tmp/**'
    ]
  },
  js.configs.recommended,
  {
    files: ['drizzle.config.ts', 'playwright.config.ts', 'frontend/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: nodeGlobals
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin
    },
    rules: {
      'no-undef': 'off',
      'no-redeclare': 'off',
      'no-console': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['frontend/*.mjs', 'frontend/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: nodeGlobals
    },
    rules: {
      'no-console': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['server.ts', 'server.sveltekit.ts', 'src/**/*.ts', 'scripts/**/*.ts', 'workers/**/*.ts', 'db/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: nodeGlobals,
      parser: tseslint.parser
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin
    },
    rules: {
      'no-undef': 'off',
      'no-redeclare': 'off',
      'no-console': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['**/*.js'],
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
    }
  }
];
