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
];
