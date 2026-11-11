// Lint for mistakes that break the app at runtime (undefined names, unused leftovers, unreachable code), not for style.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['design/**', 'node_modules/**', 'dist/**'] },
  js.configs.recommended,
  { files: ['server/**/*.js', 'electron/**/*.js', 'scripts/**/*.mjs', '*.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.node } },
  { files: ['electron/**/*.cjs'], languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: globals.node } },
  { files: ['web/**/*.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.browser } },
  { rules: { 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }], 'no-empty': ['error', { allowEmptyCatch: true }] } },
];
