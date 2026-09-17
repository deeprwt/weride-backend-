// @ts-check
import base from './base.mjs';
import globals from 'globals';

export default [
  ...base,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
];
