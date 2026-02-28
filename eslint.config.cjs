const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'data/**',
      '.git/**',
      'public/styles/*.json',
      'public/i18n/ru.js'
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
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
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
