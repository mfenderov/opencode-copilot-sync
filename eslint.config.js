// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'coverage/**',
      'test/mocks/**',
      '.vscode-test/**',
      '.test-extensions/**',
      '.test-user-data/**',
      '*.vsix',
    ],
  },
  {
    // Type-aware strict linting is scoped to src/**/*.ts only: that's the
    // shipped extension code needing these guarantees. Config/script/test
    // files are plain JS/mocks and aren't part of this ruleset.
    files: ['src/**/*.ts'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Directly targets the bug class that caused the undici Node-version
      // incident: an unawaited async call failing silently at runtime.
      '@typescript-eslint/no-floating-promises': 'error',
      // '^_'-prefixed args/vars are an established convention here for
      // intentionally-unused params (e.g. VS Code interface signatures
      // like provideLanguageModelChatInformation(_options, _token)).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Plain number/boolean interpolation (`${count} items`) is safe and
      // idiomatic; only flag genuinely unsafe (e.g. `any`/object) interpolation.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
    },
  },
);
