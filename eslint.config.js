import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/generated/**',
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      'services/**',
      'eval/**',
      // Sample repository content reviewed by the CLI example, not project code.
      'apps/cli/examples/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            'eslint.config.js',
            'vitest.config.ts',
            'packages/db/prisma.config.ts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      // Async fakes and Fastify plugins legitimately have no await.
      '@typescript-eslint/require-await': 'off',
    },
  },
  { files: ['**/*.js', 'packages/db/prisma.config.ts'], ...tseslint.configs.disableTypeChecked },
);
