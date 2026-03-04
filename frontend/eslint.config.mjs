import js from '@eslint/js';
import globals from 'globals';
import svelte from 'eslint-plugin-svelte';
import prettier from 'eslint-config-prettier';

export default [
  {
    ignores: ['.svelte-kit/**', 'build/**', 'dist/**']
  },
  js.configs.recommended,
  ...svelte.configs['flat/recommended'],
  prettier,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser
      }
    },
    rules: {
      'no-console': 'off'
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
      'no-console': 'off',
      'no-empty': 'off',
      'no-unused-vars': 'off',
      'no-extra-boolean-cast': 'off',
      'svelte/no-navigation-without-resolve': 'off',
      'svelte/prefer-svelte-reactivity': 'off',
      'svelte/no-at-html-tags': 'off',
      'svelte/require-each-key': 'off'
    }
  }
];
