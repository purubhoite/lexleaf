import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const nodeGlobals = {
  console: 'readonly',
  process: 'readonly',
  URL: 'readonly',
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/resources/dictionary/**',
      '**/*.config.js',
    ],
    languageOptions: { globals: nodeGlobals },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'no-empty': 'off',
    },
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-empty': 'off',
      'no-useless-escape': 'off',
    },
  },
  prettier,
);
