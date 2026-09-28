import node from '@uride/config/eslint/node';

export default [
  ...node,
  {
    rules: {
      // NestJS uses decorators + DI heavily; quiet rules that conflict.
      '@typescript-eslint/no-extraneous-class': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  {
    // .cjs files are CommonJS by definition — tailwind presets and jest configs
    // are loaded by tools that require() them. Flagging require() there reports
    // an error for writing the only syntax that works.
    files: ['**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
];
