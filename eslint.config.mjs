import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'data/**',
      '.git/**',
      'legacy/**',
      'frontend/.svelte-kit/**'
    ]
  },
  js.configs.recommended,
  {
    files: [
      'server.js',
      'playwright.config.js',
      'src/**/*.js',
      'scripts/**/*.js',
      'workers/**/*.js',
      'db/migrations/**/*.js',
      'db/drizzle/**/*.js',
      'drizzle.config.js',
      'tests/**/*.js'
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        ...globals.node
      }
    },
    rules: {
      'no-redeclare': 'off',
      'no-console': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['frontend/src/**/*.js', 'frontend/static/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        maplibregl: 'readonly',
        pmtiles: 'readonly'
      }
    },
    rules: {
      'no-console': 'off',
      'no-extra-boolean-cast': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['**/*.js'],
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
    }
  }
];
