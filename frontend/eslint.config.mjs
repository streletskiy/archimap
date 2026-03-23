import js from '@eslint/js';
import globals from 'globals';
import svelte from 'eslint-plugin-svelte';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: ['.svelte-kit/**', 'build/**', 'dist/**', 'src/lib/components/ui/**', 'svelte.config.js', 'static/theme-init.js']
  },
  js.configs.recommended,
  ...svelte.configs['flat/recommended'],
  prettier,
  {
    files: ['*.ts', 'src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parser: tseslint.parser,
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin
    },
    rules: {
      'no-undef': 'off',
      'no-console': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['src/**/*.svelte'],
    languageOptions: {
      globals: {
        ...globals.browser
      }
    },
    rules: {
      'no-undef': 'off',
      'no-console': 'off',
      'no-empty': 'off',
      'no-unused-vars': 'off',
      'no-extra-boolean-cast': 'off',
      'svelte/no-navigation-without-resolve': 'off',
      'svelte/prefer-svelte-reactivity': 'off',
      'svelte/no-at-html-tags': 'off',
      'svelte/require-each-key': 'off',
      'svelte/no-immutable-reactive-statements': 'off',
      'svelte/infinite-reactive-loop': 'off'
    }
  }
];
