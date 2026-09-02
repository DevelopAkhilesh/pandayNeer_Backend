import js from '@eslint/js';
import globals from 'globals';
import { defineConfig } from 'eslint/config';

export default defineConfig([
  {
    files: ['**/*.{js,mjs,cjs}'],
    plugins: { js },
    extends: ['js/recommended'],
    // Node, not browser. This is a backend — `globals.browser` left `process`
    // undefined and reported it as an error in every file that reads env.
    languageOptions: { globals: globals.node },
    rules: {
      // Express identifies error middleware by arity — it must take exactly
      // four parameters, whether or not `next` is called. Underscore-prefixed
      // arguments are load-bearing signature, not dead code.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
]);
