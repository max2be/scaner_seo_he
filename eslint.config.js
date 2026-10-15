import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '.agents/**', '.ai-factory/**'] },
  js.configs.recommended, ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-use-before-define': ['error', {
        functions: false, classes: true, variables: true, typedefs: false, ignoreTypeReferences: true,
      }],
      '@typescript-eslint/member-ordering': ['error', {
        default: 'never',
        classes: ['field', 'constructor', ['method', 'get', 'set', 'accessor', 'static-initialization']],
        classExpressions: ['field', 'constructor', ['method', 'get', 'set', 'accessor', 'static-initialization']],
      }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
);
