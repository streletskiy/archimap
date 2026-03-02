import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'data/**',
      '.git/**',
      'public/**/*.js',
      'public/styles/*.json',
      'public/app/**',
      'frontend/.svelte-kit/**'
    ]
  },
  js.configs.recommended,
  {
    files: [
      'server.js',
      'auth.js',
      'scripts/**/*.js',
      'email-templates/**/*.js',
      'infra/**/*.js',
      'routes/**/*.js',
      'services/**/*.js',
      'workers/**/*.js',
      'db/migrations/**/*.js',
      'tests/**/*.js'
    ],
    languageOptions: {
      ecmaVersion: 2022,
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
    files: ['frontend/src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
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
