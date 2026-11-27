// Lint for mistakes that break the app at runtime (undefined names, unused leftovers, unreachable code), not for style.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'dist/**', 'build/**'] },
  js.configs.recommended,
  { files: ['server/**/*.js', 'electron/**/*.js', 'tests/**/*.mjs', 'scripts/**/*.mjs', '*.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.node } },
  { files: ['electron/**/*.cjs'], languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: globals.node } },
  { files: ['web/**/*.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.browser } },
  // The page: markup is only ever written with the html tag (which escapes what is put into it) and only ever reaches
  // the document through put() in view.js. markdown.js is the one place that builds markup by hand, from text it escapes itself.
  { files: ['web/**/*.js'], ignores: ['web/markdown.js'], rules: { 'no-restricted-syntax': ['error',
    { selector: ':not(TaggedTemplateExpression) > TemplateLiteral > TemplateElement[value.raw=/<[a-zA-Z]/]', message: 'Write markup with the html tag, so what is put into it is escaped.' },
    { selector: 'Literal[value=/<[a-zA-Z][^<]*>/]', message: 'Write markup with the html tag, so what is put into it is escaped.' },
    { selector: 'CallExpression[callee.property.name=/^(insertAdjacentHTML|write|writeln)$/]', message: 'Markup reaches the page only through put() in view.js.' }] } },
  { files: ['web/**/*.js'], ignores: ['web/view.js'], rules: { 'no-restricted-properties': ['error', { property: 'innerHTML', message: 'Markup reaches the page only through put() in view.js.' }, { property: 'outerHTML', message: 'Markup reaches the page only through put() in view.js.' }] } },
  { rules: { 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }], 'no-empty': ['error', { allowEmptyCatch: true }] } },
];
